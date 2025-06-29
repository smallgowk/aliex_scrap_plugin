importScripts('firebase/firebase-app-compat.js');
importScripts('firebase/firebase-database-compat.js');

// Background script - Removed Auto-rerun functionality
let isCrawling = false;
let currentTabId = null;
let crawledItemIds = new Set();
let currentTrackingStatus = null;
let isTaskRunning = false;
let lastTrackingMessage = null;
let isCrawlingAli = false;
let currentCrawlingPage = 1;

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyA4DMIabySBRKXkO4t2w6_Tsx-MgyHG0UA",
  authDomain: "drop-aliex.firebaseapp.com",
  databaseURL: "https://drop-aliex-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "drop-aliex",
  storageBucket: "drop-aliex.firebasestorage.app",
  messagingSenderId: "441164202735",
  appId: "1:441164202735:web:b446ef04a91ebe20b4111a",
  measurementId: "G-8F4NJR3KQN"
};
let firebaseApp = null;
let firebaseDatabase = null;

async function ensureFirebase() {
    if (!firebaseApp) {
        firebaseApp = firebase.initializeApp(firebaseConfig);
        firebaseDatabase = firebase.database();
    }
    return firebaseDatabase;
}

// Function to reset crawling state
function resetCrawlingState() {
    isCrawling = false;
    currentTabId = null;
    crawledItemIds.clear();
    pageCount = 0;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_CRAWL') {
        if (!isCrawling) {
            isCrawling = true;
            currentTabId = message.tabId;
            crawledItemIds.clear();
            startCrawling(message.tabId);
            sendResponse({ success: true });
        } else {
            // If crawling is stuck, allow force reset
            if (message.forceReset) {
                resetCrawlingState();
                isCrawling = true;
                currentTabId = message.tabId;
                startCrawling(message.tabId);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, message: 'Crawling already in progress' });
            }
        }
    } else if (message.type === 'STOP_CRAWL') {
        resetCrawlingState();
        sendResponse({ success: true });
    } else if (message.type === 'RESET_CRAWL_STATE') {
        resetCrawlingState();
        sendResponse({ success: true });
    } else if (message.type === 'START_FETCH_TRACKING') {
        if (isTaskRunning) {
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, isTaskRunning: true } });
            sendResponse({ success: false, message: 'Task already running' });
            return true;
        }
        isTaskRunning = true;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: true };
        lastTrackingMessage = message;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Started tracking...', isTaskRunning: true } });
        handleFetchTracking(message, sender, sendResponse);
        sendResponse({ success: true });
        return true;
    } else if (message.type === 'STOP_FETCH_TRACKING' || message.type === 'STOP_CRAWL_ALIEX_PRODUCTS') {
        isTaskRunning = false;
        isCrawlingAli = false;
        currentCrawlingPage = 1;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: false };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Stopped by user.', isTaskRunning: false, currentPage: currentCrawlingPage } });
        sendResponse({ success: true });
        return true;
    } else if (message.type === 'GET_CURRENT_STATUS') {
        sendResponse({ ...currentTrackingStatus, isTaskRunning: isTaskRunning || isCrawlingAli, currentPage: currentCrawlingPage });
        return true;
    } else if (message.type === 'CRAWL_ALIEX_PRODUCTS') {
        if (isCrawlingAli) {
            sendResponse({ success: false, message: 'A crawling task is already running.' });
            return true;
        }
        const { diskSerialNumber, tabId } = message;
        if (!diskSerialNumber) {
            sendResponse({ success: false, message: 'Disk Serial Number must not be empty!' });
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Disk Serial Number must not be empty!', isTaskRunning: false, currentPage: 1 } });
            return true;
        }
        (async () => {
            try {
                isCrawlingAli = true;
                currentCrawlingPage = 1;
                let allProductIds = [];
                let signature = null;
                let page = 1;
                let isStore = false;
                let totalSent = 0;
                let crawlType = 'search';
                let baseUrl = '';
                let isFirstPage = true;
                while (isCrawlingAli) {
                    console.log(`[Crawl] Crawling page ${page}`);
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Crawling page ${page}...`, isTaskRunning: true, currentPage: page } });
                    let pageToCrawl = page;
                    if (isFirstPage) {
                        // Xác định isStore dựa vào url hiện tại
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (tab && tab.url && tab.url.includes('/store/')) {
                            isStore = true;
                        } else {
                            isStore = false;
                        }
                        if (!isStore) {
                            // Lấy BASE_URL từ tab hiện tại, loại bỏ param page nếu có
                            if (tab && tab.url) {
                                let url = new URL(tab.url);
                                url.searchParams.delete('page');
                                baseUrl = url.toString();
                            }
                        }
                        isFirstPage = false;
                    }
                    if (!isStore) {
                        // Tạo url mới với page param
                        let urlObj = new URL(baseUrl);
                        urlObj.searchParams.set('page', pageToCrawl);
                        await new Promise(resolve => {
                            chrome.tabs.update(tabId, { url: urlObj.toString() }, () => resolve());
                        });
                        // Đợi trang load xong (polling)
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        // Scroll nhiều lần, dừng khi không còn item lazy-load
                        let tries = 0;
                        let maxTries = 30;
                        while (tries < maxTries) {
                            console.log(`[Crawl] Scroll attempt ${tries + 1} for page ${page}`);
                            await chrome.scripting.executeScript({
                                target: { tabId },
                                func: () => {
                                    // Scroll đến item cuối cùng có class hs_bu search-item-card-wrapper-gallery
                                    const items = document.querySelectorAll('div.hs_bu.search-item-card-wrapper-gallery');
                                    if (items && items.length > 0) {
                                        items[items.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                                    } else {
                                        window.scrollTo(0, document.body.scrollHeight);
                                    }
                                }
                            });
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            // Kiểm tra còn item lazy-load không
                            let lazyCountRes = await chrome.scripting.executeScript({
                                target: { tabId },
                                func: () => {
                                    const cardList = document.querySelector('div.hs_ht[data-spm="main"]#card-list');
                                    if (cardList) {
                                        return Array.from(cardList.children).filter(e => e.classList.contains('lazy-load')).length;
                                    }
                                    return 0;
                                }
                            });
                            const lazyCount = lazyCountRes && lazyCountRes[0] && lazyCountRes[0].result ? lazyCountRes[0].result : 0;
                            console.log(`[Crawl] After scroll ${tries + 1}, lazy-load items left: ${lazyCount}`);
                            if (lazyCount === 0) {
                                // Sau khi hết lazy-load, tiếp tục scroll đến khi tìm thấy .hv_e5 (phân trang)
                                let foundPaging = false;
                                let pagingTries = 0;
                                let maxPagingTries = 20;
                                while (!foundPaging && pagingTries < maxPagingTries) {
                                    const pagingRes = await chrome.scripting.executeScript({
                                        target: { tabId },
                                        func: () => {
                                            return !!document.querySelector('div.hv_e5');
                                        }
                                    });
                                    foundPaging = pagingRes && pagingRes[0] && pagingRes[0].result;
                                    if (foundPaging) {
                                        console.log('[Crawl] Found paging element <div class="hv_e5">');
                                        break;
                                    }
                                    // Scroll xuống cuối trang thêm lần nữa
                                    await chrome.scripting.executeScript({
                                        target: { tabId },
                                        func: () => {
                                            window.scrollTo(0, document.body.scrollHeight);
                                        }
                                    });
                                    await new Promise(resolve => setTimeout(resolve, 800));
                                    pagingTries++;
                                }
                                break;
                            }
                            tries++;
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    const results = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            let productIds = [];
                            if (window.location.href.includes('/store/')) {
                                // STORE: lấy toàn bộ thẻ a trên trang
                                const anchors = Array.from(document.querySelectorAll('a[href]'));
                                const regex = /\.aliexpress\.com\/item\/(\d+)\.html/;
                                const ids = anchors.map(a => {
                                    const m = a.getAttribute('href').match(regex);
                                    return m ? m[1] : null;
                                }).filter(Boolean);
                                productIds = Array.from(new Set(ids));
                            } else {
                                // SEARCH: chỉ lấy trong #card-list
                                const cardList = document.querySelector('div.hs_ht[data-spm="main"]#card-list');
                                if (cardList) {
                                    const anchors = Array.from(cardList.querySelectorAll('a[href]'));
                                    const regex = /\.aliexpress\.com\/item\/(\d+)\.html/;
                                    const ids = anchors.map(a => {
                                        const m = a.getAttribute('href').match(regex);
                                        return m ? m[1] : null;
                                    }).filter(Boolean);
                                    productIds = Array.from(new Set(ids));
                                }
                            }
                            // Get signature
                            let signature = null;
                            // 1. Try to find a[data-href*=".aliexpress.com/store/"]
                            const storeA = Array.from(document.querySelectorAll('a[data-href*=".aliexpress.com/store/"]')).find(a => {
                                const m = a.getAttribute('data-href').match(/\.aliexpress\.com\/store\/(\d+)/);
                                return m;
                            });
                            if (storeA) {
                                const m = storeA.getAttribute('data-href').match(/\.aliexpress\.com\/store\/(\d+)/);
                                const storeId = m[1];
                                let text = storeA.innerText || storeA.textContent || '';
                                text = text.trim().toLowerCase().replace(/\s+/g, '_');
                                signature = `${storeId}_${text}`;
                            } else {
                                // 2. Try to find input.search--keyword--15P08Ji
                                const input = document.querySelector('input.search--keyword--15P08Ji');
                                if (input && input.value) {
                                    signature = input.value.trim().toLowerCase().replace(/\s+/g, '_');
                                }
                            }
                            // Lấy country flag và language
                            let countryFlag = '';
                            let language = '';
                            const shipTo = document.querySelector('.ship-to--menuItem--WdBDsYl');
                            if (shipTo) {
                                const flagSpan = shipTo.querySelector('span[class*="country-flag-"]');
                                if (flagSpan) {
                                    const classList = Array.from(flagSpan.classList);
                                    // Tìm class bắt đầu bằng 'country-flag-' và lấy phần sau cùng (thường là US)
                                    const flagClass = classList.find(cls => cls.startsWith('country-flag-'));
                                    if (flagClass) {
                                        const parts = flagClass.split(' ');
                                        countryFlag = parts[parts.length - 1].replace('country-flag-', '').toUpperCase();
                                        // Nếu vẫn chưa đúng, thử lấy phần tử cuối cùng của classList nếu nó là 2 ký tự
                                        if (!countryFlag || countryFlag.length !== 2) {
                                            const last = classList[classList.length - 1];
                                            if (last.length === 2) countryFlag = last.toUpperCase();
                                        }
                                    } else {
                                        // fallback lấy phần tử cuối cùng nếu là 2 ký tự
                                        const last = classList[classList.length - 1];
                                        if (last.length === 2) countryFlag = last.toUpperCase();
                                    }
                                }
                                const langSpan = shipTo.querySelector('.ship-to--small--1wG1oGl');
                                if (langSpan) {
                                    const langText = langSpan.textContent || '';
                                    // Lấy 2 ký tự in hoa cuối cùng trước dấu /
                                    const match = langText.match(/\/([A-Z]{2})\//);
                                    if (match) {
                                        language = match[1];
                                    } else {
                                        // fallback: lấy 2 ký tự in hoa cuối cùng
                                        const fallback = langText.match(/([A-Z]{2})\/?$/);
                                        if (fallback) language = fallback[1];
                                    }
                                }
                            }
                            // Lấy currentPage và totalpage nếu là store
                            let storePageInfo = { currentPage: null, totalpage: null };
                            const storePageDiv = document.querySelector('div[currentpage][totalpage]');
                            if (storePageDiv) {
                                storePageInfo.currentPage = storePageDiv.getAttribute('currentpage');
                                storePageInfo.totalpage = storePageDiv.getAttribute('totalpage');
                            }
                            // Lấy totalPage cho search (không phải store)
                            let searchTotalPage = null;
                            if (!window.location.href.includes('/store/')) {
                                const quickJumper = document.querySelector('.comet-pagination-options-quick-jumper');
                                if (quickJumper) {
                                    const textNodes = Array.from(quickJumper.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
                                    let totalPageText = null;
                                    for (const node of textNodes) {
                                        const match = node.textContent.match(/\/(\d+)/);
                                        if (match) {
                                            totalPageText = match[1];
                                            break;
                                        }
                                    }
                                    if (!totalPageText) {
                                        // fallback: lấy từ innerText
                                        const m = quickJumper.innerText.match(/\/(\d+)/);
                                        if (m) totalPageText = m[1];
                                    }
                                    if (totalPageText) searchTotalPage = totalPageText;
                                }
                            }
                            return { productIds, signature, isStore: !!storeA, countryFlag, language, storePageInfo, searchTotalPage };
                        }
                    });
                    if (!isCrawlingAli) break;
                    let { productIds, signature: sig, isStore: storeFlag, countryFlag, language, storePageInfo, searchTotalPage } = results && results[0] && results[0].result ? results[0].result : { productIds: [], signature: null, isStore: false, countryFlag: '', language: '', storePageInfo: { currentPage: null, totalpage: null }, searchTotalPage: null };
                    // Chỉ ghép countryFlag và language vào signature một lần duy nhất
                    if (!signature && sig) signature = sig;
                    if (signature && countryFlag && language && !signature.match(/_[A-Z]{2}_[A-Z]{2}$/)) {
                        signature = `${signature}_${countryFlag}_${language}`;
                    }
                    isStore = storeFlag;
                    crawlType = isStore ? 'store' : 'search';
                    // Xác định pageIndex để update Firebase
                    let pageIndex = page;
                    let totalPageValue = undefined;
                    if (isStore && storePageInfo && storePageInfo.currentPage) {
                        pageIndex = storePageInfo.currentPage;
                        if (storePageInfo.totalpage) totalPageValue = storePageInfo.totalpage;
                    } else if (!isStore) {
                        pageIndex = pageToCrawl;
                        if (searchTotalPage) totalPageValue = searchTotalPage;
                    }
                    if (productIds.length === 0) {
                        // Nếu không còn sản phẩm nào thì dừng
                        break;
                    }
                    if (productIds.length && signature) {
                        const apiRes = await fetch('http://iamhere.vn:89/api/ggsheet/pushAliexProducts', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ signature, listProducts: productIds, diskSerialNumber })
                        });
                        if (!isCrawlingAli) break;
                        if (!apiRes.ok) {
                            sendResponse({ success: false, message: `API request failed at page ${page}.` });
                            isCrawlingAli = false;
                            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Stopped by error.`, isTaskRunning: false, currentPage: page } });
                            return;
                        }
                        totalSent += productIds.length;
                        // Update Firebase
                        try {
                            const db = await ensureFirebase();
                            const safeDiskSerial = diskSerialNumber.replace(/\./g, '_dot_');
                            const now = Date.now();
                            const pageRef = db.ref(`aliexpress/${safeDiskSerial}/${signature}`);
                            let updateObj = { lastUpdate: now, type: crawlType };
                            if (typeof totalPageValue !== 'undefined') {
                                console.log('[TRACE] totalPageValue:', totalPageValue);
                                updateObj.totalpage = totalPageValue;
                            } else {
                                console.log('[TRACE] totalPageValue is undefined');
                            }
                            console.log('[TRACE] updateObj before Firebase update:', updateObj);
                            await pageRef.update(updateObj);
                            await pageRef.child('pages').child(String(pageIndex)).set(productIds);
                        } catch (e) {
                            // ignore firebase error, just log
                            console.error('Firebase update error:', e);
                        }
                    }
                    allProductIds.push(...productIds);
                    let hasNext = false;
                    if (isStore) {
                        const nextRes = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const nextDiv = Array.from(document.querySelectorAll('div[style*="background-image"]')).find(div => {
                                    return div.style.backgroundImage.includes('ae01.alicdn.com/kf/Sfbc266a67ab34b2dbfacf350a02d2ee50/120x120.png');
                                });
                                if (nextDiv && nextDiv.offsetParent !== null) {
                                    nextDiv.click();
                                    return true;
                                }
                                return false;
                            }
                        });
                        hasNext = nextRes && nextRes[0] && nextRes[0].result;
                    } else {
                        hasNext = true; // search query luôn tăng page cho đến khi không còn sản phẩm
                    }
                    if (!hasNext && isStore) break;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    if (!isCrawlingAli) break;
                    page++;
                    currentCrawlingPage = page;
                    if (page > 50) break;
                }
                allProductIds = Array.from(new Set(allProductIds));
                isCrawlingAli = false;
                currentCrawlingPage = 1;
                if (!allProductIds.length) {
                    sendResponse({ success: false, message: 'No products found.' });
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'No products found.', isTaskRunning: false, currentPage: 1 } });
                    return;
                }
                if (!signature) {
                    sendResponse({ success: false, message: 'No valid signature found.' });
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'No valid signature found.', isTaskRunning: false, currentPage: 1 } });
                    return;
                }
                sendResponse({ success: true, message: `Sent total ${totalSent} products with signature ${signature}.` });
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Crawling completed. Sent total ${totalSent} products.`, isTaskRunning: false, currentPage: 1 } });
            } catch (err) {
                isCrawlingAli = false;
                currentCrawlingPage = 1;
                sendResponse({ success: false, message: 'Error: ' + err.message });
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Stopped by error.', isTaskRunning: false, currentPage: 1 } });
            }
        })();
        return true;
    }
    return true;
});

// Function to find and click next button
async function findAndClickNext(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                const nextButtons = Array.from(document.querySelectorAll('div[style*="background-image"]'));
                if (nextButtons.length > 0) {
                    const nextButton = nextButtons[nextButtons.length - 1];
                    if (nextButton && nextButton.offsetParent !== null) {
                        nextButton.click();
                        return true;
                    }
                }
                return false;
            }
        });
        return results && results[0] && results[0].result;
    } catch (error) {
        console.error('Error finding/clicking next button:', error);
        return false;
    }
}

// Function to crawl a single page
async function crawlPage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                try {
                    const links = Array.from(document.querySelectorAll('a[href*="/item/"]'));
                    const itemIds = links.map(link => {
                        const match = link.href.match(/\/item\/(\d+)/);
                        return match ? match[1] : null;
                    }).filter(id => id !== null);
                    return [...new Set(itemIds)];
                } catch (error) {
                    console.error('Error in content script:', error);
                    throw error;
                }
            }
        });

        if (results && results[0] && results[0].result) {
            const newIds = results[0].result;
            newIds.forEach(id => crawledItemIds.add(id));
            
            // Update popup status if it's open
            chrome.runtime.sendMessage({
                type: 'UPDATE_STATUS',
                data: {
                    currentPage: pageCount,
                    totalItems: crawledItemIds.size
                }
            });
            
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error crawling page:', error);
        return false;
    }
}

let pageCount = 0;
const maxPages = 10;

// Main crawling function
async function startCrawling(tabId) {
    try {
        pageCount = 0;
        
        while (pageCount < maxPages && isCrawling) {
            pageCount++;
            
            // Crawl current page
            const success = await crawlPage(tabId);
            if (!success) {
                chrome.runtime.sendMessage({
                    type: 'CRAWL_ERROR',
                    error: 'Failed to crawl page'
                });
                break;
            }

            // Try to find and click next button
            const hasNext = await findAndClickNext(tabId);
            if (!hasNext) {
                chrome.runtime.sendMessage({
                    type: 'CRAWL_COMPLETE',
                    data: {
                        totalItems: crawledItemIds.size
                    }
                });
                break;
            }

            // Wait for page to load
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        console.error('Error in startCrawling:', error);
        chrome.runtime.sendMessage({
            type: 'CRAWL_ERROR',
            error: error.message
        });
    } finally {
        // Always reset crawling state when done
        resetCrawlingState();
    }
}

async function handleFetchTracking(message, sender, sendResponse) {
    const BASE_API_URL = 'http://iamhere.vn:89/api/ggsheet';
    const { sheetId, sheetName, tabId } = message;
    try {
        currentTrackingStatus = { currentPage: 0, totalItems: 0, status: 'Fetching orderId list from Google Sheet...', isTaskRunning: true };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
        const infoRes = await fetch(`${BASE_API_URL}/getInfo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sheetId, sheetName })
        });
        if (!infoRes.ok) throw new Error('Error calling getInfo API');
        
        const infoData = await infoRes.json();
        if (!infoData.data || !Array.isArray(infoData.data)) throw new Error('Invalid API response');
        
        const orderIds = infoData.data;
        if (orderIds.length === 0) throw new Error('No orderId found in sheet!');
        
        currentTrackingStatus = { currentPage: 0, totalItems: orderIds.length, status: `Crawling tracking number for ${orderIds.length} orderId...`, isTaskRunning: true };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
        for (let i = 0; i < orderIds.length; i++) {
            // Check if task was stopped
            if (!isTaskRunning) {
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Task stopped by user', isTaskRunning: false } });
                return;
            }
            
            const orderId = orderIds[i];
            currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `(${i+1}/${orderIds.length}) Getting tracking for orderId: ${orderId}`, isTaskRunning: true };
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            
            // Open tracking tab
            const trackingUrl = `https://www.aliexpress.com/p/tracking/index.html?_addShare=no&_login=yes&tradeOrderId=${orderId}`;
            const trackingTab = await chrome.tabs.create({ url: trackingUrl, active: false });
            await new Promise(resolve => setTimeout(resolve, 4000));
            
            // Inject script to get tracking number
            const [{ result: trackingNumberRaw }] = await chrome.scripting.executeScript({
                target: { tabId: trackingTab.id },
                func: () => {
                    const el = document.querySelector('.logistic-info-v2--mailNoValue--X0fPzen');
                    return el ? el.textContent.trim() : '';
                }
            });
            const trackingNumber = trackingNumberRaw || 'Error!';
            await chrome.tabs.remove(trackingTab.id);
            
            // Update sheet
            currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Updating tracking for orderId: ${orderId}...`, isTaskRunning: true };
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            
            const datamap = {};
            datamap[orderId] = trackingNumber;
            const updateRes = await fetch(`${BASE_API_URL}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sheetId, sheetName, datamap })
            });
            
            if (!updateRes.ok) {
                currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Error updating orderId: ${orderId}`, isTaskRunning: true };
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            } else {
                currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Updated tracking for orderId: ${orderId}`, isTaskRunning: true };
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            }
        }
        
        currentTrackingStatus = { currentPage: orderIds.length, totalItems: orderIds.length, status: 'All tracking numbers updated!', isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
    } catch (error) {
        currentTrackingStatus = { currentPage: 0, totalItems: 0, status: 'Error: ' + error.message, isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'CRAWL_ERROR', error: error.message });
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
    }
}