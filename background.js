// Background script - Removed Auto-rerun functionality
let isCrawling = false;
let currentTabId = null;
let crawledItemIds = new Set();
let currentTrackingStatus = null;
let isTaskRunning = false;
let lastTrackingMessage = null;
let isCrawlingAli = false;
let currentCrawlingPage = 1;

const DOMAIN = 'https://iamhere.vn/';
// const DOMAIN = 'http://localhost:8089/';

// Helper functions for saving/loading crawl state
async function saveCrawlState(state) {
    try {
        await chrome.storage.local.set({ crawlState: state });
        console.log('[Crawl] State saved:', state);
    } catch (error) {
        console.error('[Crawl] Error saving state:', error);
    }
}

async function loadCrawlState() {
    try {
        const result = await chrome.storage.local.get(['crawlState']);
        return result.crawlState || null;
    } catch (error) {
        console.error('[Crawl] Error loading state:', error);
        return null;
    }
}

async function clearCrawlState() {
    try {
        await chrome.storage.local.remove(['crawlState']);
        console.log('[Crawl] State cleared');
    } catch (error) {
        console.error('[Crawl] Error clearing state:', error);
    }
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
        console.log('[Crawl] Stop message received, setting isCrawlingAli = false');
        isTaskRunning = false;
        isCrawlingAli = false;
        currentCrawlingPage = 1;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: false };
        clearCrawlState(); // Clear saved state when stopping
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Stopped by user.', isTaskRunning: false, currentPage: currentCrawlingPage } });
        console.log('[Crawl] Stop completed, isCrawlingAli =', isCrawlingAli);
        sendResponse({ success: true });
    } else if (message.type === 'GET_CRAWL_STATE') {
        // Return current crawl state to popup
        loadCrawlState().then(state => {
            sendResponse({ 
                success: true, 
                state: state,
                isCrawling: isCrawlingAli
            });
        });
        return true; // Keep message channel open for async response
    } else if (message.type === 'GET_CURRENT_STATUS') {
        sendResponse({ ...currentTrackingStatus, isTaskRunning: isTaskRunning || isCrawlingAli, currentPage: currentCrawlingPage });
        return true;
    } else if (message.type === 'CRAWL_ALIEX_PRODUCTS_FROM_SHEET') {
        if (isCrawlingAli) {
            sendResponse({ success: false, message: 'A crawling task is already running.' });
            return true;
        }
        const { sheetId, diskSerialNumber, gettingKey } = message;
        if (!sheetId) {
            sendResponse({ success: false, message: 'Link Sheet ID must not be empty!' });
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Link Sheet ID must not be empty!', isTaskRunning: false, currentPage: 1 } });
            return true;
        }
        if (!diskSerialNumber) {
            sendResponse({ success: false, message: 'Disk Serial Number must not be empty!' });
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Disk Serial Number must not be empty!', isTaskRunning: false, currentPage: 1 } });
            return true;
        }
        if (!gettingKey) {
            sendResponse({ success: false, message: 'Getting Key must not be empty!' });
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Getting Key must not be empty!', isTaskRunning: false, currentPage: 1 } });
            return true;
        }
        
        (async () => {
            try {
                isCrawlingAli = true;
                currentCrawlingPage = 1;
                let currentLink = '';
                
                // Call API to get list of links
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Fetching links from sheet...', isTaskRunning: true, currentPage: 0 } });
                
                const apiResponse = await fetch(`${DOMAIN}api/ggsheet/getCrawlLinks`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id: sheetId,
                        gettingKey: gettingKey || ''
                    })
                });
                
                if (!apiResponse.ok) {
                    throw new Error(`API call failed with status: ${apiResponse.status}`);
                }
                
                const apiData = await apiResponse.json();
                
                if (apiData.httpStatus !== 'OK' || !apiData.data || !Array.isArray(apiData.data)) {
                    throw new Error('Invalid API response format');
                }
                
                const links = apiData.data;
                console.log(`[Crawl] Found ${links.length} links to crawl`);
                
                if (links.length === 0) {
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'No links found in sheet', pageStatus: '', isTaskRunning: false, currentPage: 0 } });
                    isCrawlingAli = false;
                    sendResponse({ success: true });
                    return;
                }
                
                                 // Get the current active tab
                 const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                 
                 if (!activeTab) {
                     throw new Error('No active tab found');
                 }
                 
                 console.log(`[Crawl] Using tab: "${activeTab.title}" (${activeTab.url})`);
                 
                         // Save initial crawl state
        await saveCrawlState({
            isCrawling: true,
            currentLink: '',
            currentPage: 0,
            totalLinks: links.length,
            currentLinkIndex: 0,
            tabTitle: activeTab.title
        });
        
        // Send initial status with tab info
        chrome.runtime.sendMessage({ 
            type: 'UPDATE_STATUS', 
            data: { 
                status: `Using tab: "${activeTab.title}"`, 
                isTaskRunning: true, 
                currentPage: 0 
            } 
        });
                 
                                 // Process each link on the current tab
                for (let i = 0; i < links.length && isCrawlingAli; i++) {
                    const link = links[i];
                    currentLink = link;
                    console.log(`[Crawl] Processing link ${i + 1}/${links.length}: ${link}, isCrawlingAli = ${isCrawlingAli}`);
                    
                    // Update crawl state
                    await saveCrawlState({
                        isCrawling: true,
                        currentLink: currentLink,
                        currentPage: 0,
                        totalLinks: links.length,
                        currentLinkIndex: i + 1,
                        tabTitle: activeTab.title
                    });
                    
                    chrome.runtime.sendMessage({ 
                        type: 'UPDATE_STATUS', 
                        data: { 
                            linkUrl: currentLink,
                            status: `Processing link ${i + 1}/${links.length}...`, 
                            isTaskRunning: true, 
                            currentPage: i + 1 
                        } 
                    });
                     
                                         // Load the link on the current tab
                    await chrome.tabs.update(activeTab.id, { url: link });
                    if (!isCrawlingAli) break; // Check after tab update
                    
                    // Wait for page to load
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    if (!isCrawlingAli) break; // Check after page load wait
                    
                    // For store pages, refresh to ensure we start from page 1
                    if (link.includes('/store/') && link.includes('/pages/all-items.html')) {
                        console.log(`[Crawl] Refreshing store page to start from page 1: ${link}`);
                        await chrome.tabs.reload(activeTab.id);
                        if (!isCrawlingAli) break; // Check after reload
                        
                        // Wait for page to load after refresh
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        if (!isCrawlingAli) break; // Check after refresh wait
                    }
                     
                                         // Get updated tab info after loading
                    const updatedTab = await chrome.tabs.get(activeTab.id);
                    if (!isCrawlingAli) break; // Check after tab info
                    console.log(`[Crawl] Loaded: "${updatedTab.title}"`);
                    
                    // Check for Captcha before crawling (signature will be empty initially)
                    const hasCaptcha = await checkCaptchaAndSendError(activeTab.id, sheetId, currentLink, '');
                    if (!isCrawlingAli) break; // Check after captcha check
                     
                     if (hasCaptcha) {
                         console.log(`[Crawl] Skipping link due to Captcha: ${currentLink}`);
                         chrome.runtime.sendMessage({ 
                             type: 'UPDATE_STATUS', 
                             data: { 
                                 linkUrl: currentLink,
                                 status: `Captcha detected - skipping link ${i + 1}/${links.length}`, 
                                 isTaskRunning: true, 
                                 currentPage: i + 1 
                             } 
                         });
                         continue; // Skip to next link
                     }
                     
                                         // Crawl the current tab
                    const crawlResult = await crawlSingleTab(activeTab.id, diskSerialNumber, i + 1, currentLink, sheetId);
                    if (!isCrawlingAli) break; // Check after crawl completion
                    
                    // If crawl was stopped due to Captcha, continue to next link
                    if (crawlResult === false) {
                        console.log(`[Crawl] Crawl stopped for link ${i + 1}, continuing to next link`);
                    }
                   
                   // Small delay between links
                   if (i < links.length - 1 && isCrawlingAli) {
                       await new Promise(resolve => setTimeout(resolve, 1000));
                       if (!isCrawlingAli) break; // Check after delay
                   }
                }
                
                if (isCrawlingAli) {
                    chrome.runtime.sendMessage({ 
                        type: 'UPDATE_STATUS', 
                        data: { 
                            linkUrl: currentLink,
                            status: `Completed crawling all ${links.length} links`, 
                            pageStatus: '',
                            isTaskRunning: false, 
                            currentPage: links.length 
                        } 
                    });
                }
                
                isCrawlingAli = false;
                clearCrawlState(); // Clear saved state when completed
                sendResponse({ success: true });
                
            } catch (error) {
                console.error('[Crawl] Error:', error);
                chrome.runtime.sendMessage({ 
                    type: 'UPDATE_STATUS', 
                    data: { 
                        linkUrl: currentLink,
                        status: `Error: ${error.message}`, 
                        pageStatus: '',
                        isTaskRunning: false, 
                        currentPage: 0 
                    } 
                });
                isCrawlingAli = false;
                clearCrawlState(); // Clear saved state on error
                sendResponse({ success: false, message: error.message });
            }
        })();
        return true;
    } else if (message.type === 'CRAWL_ALIEX_PRODUCTS') {
        if (isCrawlingAli) {
            sendResponse({ success: false, message: 'A crawling task is already running.' });
            return true;
        }
        const { diskSerialNumber, tabId, sheetId } = message;
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
                    console.log(`[Crawl] Crawling page ${page}, isCrawlingAli = ${isCrawlingAli}`);
                    
                    // Update crawl state with current page
                    await saveCrawlState({
                        isCrawling: true,
                        currentLink: 'Current Tab',
                        currentPage: page,
                        totalLinks: 1,
                        currentLinkIndex: 1,
                        tabTitle: 'Current Tab'
                    });
                    
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Crawling page ${page}...`, isTaskRunning: true, currentPage: page } });

                    // Xác định signature trước khi kiểm tra API
                    if (isFirstPage) {
                        // Xác định isStore dựa vào url hiện tại
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (tab && tab.url && tab.url.includes('/store/')) {
                            isStore = true;
                            
                            // For store pages, refresh to ensure we start from page 1
                            if (tab.url.includes('/pages/all-items.html')) {
                                console.log(`[Crawl] Refreshing store page to start from page 1: ${tab.url}`);
                                await chrome.tabs.reload(tab.id);
                                if (!isCrawlingAli) break; // Check after reload
                                
                                // Wait for page to load after refresh
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                if (!isCrawlingAli) break; // Check after refresh wait
                            }
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

                    // Lấy signature tạm thời để kiểm tra API (nếu chưa có signature thì skip kiểm tra)
                    let tempSignature = signature;
                    if (!tempSignature) {
                        // Lấy signature bằng cách inject script lấy nhanh signature (không cần lấy productIds)
                        const sigRes = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                // Lấy signature như logic cũ
                                let signature = null;
                                                                 const storeA = Array.from(document.querySelectorAll('a[data-href*=".aliexpress."]')).find(a => {
                                     const m = a.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                                     return m;
                                 });
                                 if (storeA) {
                                     const m = storeA.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                                     const storeId = m[1];
                                    let text = storeA.innerText || storeA.textContent || '';
                                    text = text.trim().toLowerCase().replace(/\s+/g, '_');
                                    signature = `${storeId}_${text}`;
                                } else {
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
                                        const flagClass = classList.find(cls => cls.startsWith('country-flag-'));
                                        if (flagClass) {
                                            const parts = flagClass.split(' ');
                                            countryFlag = parts[parts.length - 1].replace('country-flag-', '').toUpperCase();
                                            if (!countryFlag || countryFlag.length !== 2) {
                                                const last = classList[classList.length - 1];
                                                if (last.length === 2) countryFlag = last.toUpperCase();
                                            }
                                        } else {
                                            const last = classList[classList.length - 1];
                                            if (last.length === 2) countryFlag = last.toUpperCase();
                                        }
                                    }
                                    const langSpan = shipTo.querySelector('.ship-to--small--1wG1oGl');
                                    if (langSpan) {
                                        const langText = langSpan.textContent || '';
                                        const match = langText.match(/\/([A-Z]{2})\//);
                                        if (match) {
                                            language = match[1];
                                        } else {
                                            const fallback = langText.match(/([A-Z]{2})\/?$/);
                                            if (fallback) language = fallback[1];
                                        }
                                    }
                                }
                                if (signature && countryFlag && language && !signature.match(/_[A-Z]{2}_[A-Z]{2}$/)) {
                                    signature = `${signature}_${countryFlag}_${language}`;
                                }
                                return signature;
                            }
                        });
                        tempSignature = sigRes && sigRes[0] && sigRes[0].result ? sigRes[0].result : null;
                        if (tempSignature && !signature) signature = tempSignature;
                    }

                    let pageToCrawl = page;
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
                                    const items = document.querySelectorAll('div.lazy-load');
                                    if (items && items.length > 0) {
                                        items[items.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                                    } 
                                    // else {
                                    //     window.scrollTo(0, document.body.scrollHeight);
                                    // }
                                }
                            });
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            // Kiểm tra còn item lazy-load không
                            let lazyCountRes = await chrome.scripting.executeScript({
                                target: { tabId },
                                func: () => {
                                    const items = document.querySelectorAll('div.lazy-load');
                                    if (items) {
                                        return items.length;
                                    }
                                    return 0;
                                }
                            });
                            const lazyCount = lazyCountRes && lazyCountRes[0] && lazyCountRes[0].result ? lazyCountRes[0].result : 0;
                            console.log(`[Crawl] After scroll ${tries + 1}, lazy-load items left: ${lazyCount}`);
                            if (lazyCount === 0) {
                                // Sau khi hết lazy-load, tiếp tục scroll đến khi tìm thấy ul.comet-pagination (phân trang)
                                let foundPaging = false;
                                let pagingTries = 0;
                                let maxPagingTries = 20;
                                while (!foundPaging && pagingTries < maxPagingTries) {
                                    const pagingRes = await chrome.scripting.executeScript({
                                        target: { tabId },
                                        func: () => {
                                            return !!document.querySelector('ul.comet-pagination');
                                        }
                                    });
                                    // foundPaging = pagingRes && pagingRes[0] && pagingRes[0].result;
                                    foundPaging = pagingRes;
                                    if (foundPaging) {
                                        console.log('[Crawl] Found paging element <ul class="comet-pagination">');
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
                    // Thêm delay để đảm bảo trang load đầy đủ sau khi scroll
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    console.log(`[Crawl] Starting to extract product IDs for page ${page}`);
                    const results = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            let productIds = [];
                            if (window.location.href.includes('/store/')) {
                                // STORE: lấy toàn bộ thẻ a trên trang
                                const anchors = Array.from(document.querySelectorAll('a[href]'));
                                const regex = /\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/item\/(\d+)\.html/;
                                const ids = anchors.map(a => {
                                    const m = a.getAttribute('href').match(regex);
                                    return m ? m[1] : null;
                                }).filter(Boolean);
                                productIds = Array.from(new Set(ids));
                            } else {
                                // SEARCH: chỉ lấy trong #card-list
                                const cardList = document.querySelector('div[data-spm="main"]#card-list');
                                if (cardList) {
                                    console.log(`[cardList] found!`);
                                    const anchors = Array.from(cardList.querySelectorAll('a[href]'));
                                    console.log(`[Link found] ${anchors.length}!`);
                                    const regex = /\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/item\/(\d+)\.html/;
                                    const ids = anchors.map(a => {
                                        const m = a.getAttribute('href').match(regex);
                                        return m ? m[1] : null;
                                    }).filter(Boolean);
                                    console.log(`[ID found] ${ids.length}!`);
                                    productIds = Array.from(new Set(ids));
                                } else {
                                    console.log(`[cardList] not found!`);
                                }
                            }
                            // Get signature
                            let signature = null;
                            // 1. Try to find any aliexpress store link
                            const storeA = Array.from(document.querySelectorAll('a[data-href*=".aliexpress."]')).find(a => {
                                const m = a.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                                return m;
                            });
                            if (storeA) {
                                const m = storeA.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
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
                                    // Tìm text node chứa "/60" hoặc tương tự
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
                    // Always call API even if no products found
                    if (signature) {
                        // Get current tab URL for linkCrawling
                        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        const currentTabUrl = currentTab ? currentTab.url : '';
                        
                        console.log('[pushAliexProducts] Payload:', {
                            signature, 
                            listProducts: productIds, 
                            diskSerialNumber: diskSerialNumber,
                            totalPage: totalPageValue,
                            pageNumber: pageIndex,
                            linkSheetId: sheetId,
                            linkSheetName: '', // Not available in single tab crawling
                            linkCrawling: currentTabUrl
                        });
                                                 const apiRes = await fetch(`${DOMAIN}api/ggsheet/pushAliexProducts`, {
                             method: 'POST',
                             headers: { 'Content-Type': 'application/json' },
                             body: JSON.stringify({ 
                                 signature, 
                                 listProducts: productIds, 
                                 diskSerialNumber: diskSerialNumber,
                                 totalPage: totalPageValue,
                                 pageNumber: pageIndex,
                                 linkSheetId: sheetId,
                                 linkSheetName: '', // Not available in single tab crawling
                                 linkCrawling: currentTabUrl
                             })
                         });
                        if (!isCrawlingAli) break;
                        if (!apiRes.ok) {
                            sendResponse({ success: false, message: `API request failed at page ${page}.` });
                            isCrawlingAli = false;
                            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Stopped by error.`, isTaskRunning: false, currentPage: page } });
                            return;
                        }
                        totalSent += productIds.length;
                        
                        // If no products found, stop crawling
                        if (productIds.length === 0) {
                            console.log(`[Crawl] No products found on page ${page}, stopping crawl`);
                            break;
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
                        // Kiểm tra xem có trang tiếp theo không dựa trên cấu trúc phân trang mới
                        const nextPageRes = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                // Kiểm tra xem có nút "next" không bị disabled
                                const nextButton = document.querySelector('.comet-pagination-next:not(.comet-pagination-disabled)');
                                if (nextButton) {
                                    return true;
                                }
                                // Kiểm tra xem có trang tiếp theo trong danh sách không
                                const currentPage = document.querySelector('.comet-pagination-item-active');
                                if (currentPage) {
                                    const currentPageNumber = parseInt(currentPage.textContent);
                                    const allPageItems = Array.from(document.querySelectorAll('.comet-pagination-item'));
                                    const maxPageNumber = Math.max(...allPageItems.map(item => {
                                        const num = parseInt(item.textContent);
                                        return isNaN(num) ? 0 : num;
                                    }));
                                    return currentPageNumber < maxPageNumber;
                                }
                                return false;
                            }
                        });
                        hasNext = nextPageRes && nextPageRes[0] && nextPageRes[0].result;
                    }
                    if (!hasNext) break;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    if (!isCrawlingAli) break;
                    page++;
                    currentCrawlingPage = page;
                    continue;
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
    const BASE_API_URL = `${DOMAIN}api/ggsheet`;
            const { sheetId, tabId } = message;
    try {
        currentTrackingStatus = { currentPage: 0, totalItems: 0, status: 'Fetching orderId list from Google Sheet...', isTaskRunning: true };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
        const infoRes = await fetch(`${BASE_API_URL}/getInfo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sheetId })
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
                body: JSON.stringify({ id: sheetId, datamap })
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

// Function to reset crawling state
function resetCrawlingState() {
    isCrawling = false;
    currentTabId = null;
    crawledItemIds.clear();
    pageCount = 0;
}

// Function to check for Captcha and send error API
async function checkCaptchaAndSendError(tabId, sheetId, currentLink, signature) {
    try {
        const tab = await chrome.tabs.get(tabId);
        const title = tab.title || '';
        const url = tab.url || '';
        
        console.log(`[Crawl] Checking Captcha - Title: "${title}", URL: "${url}"`);
        
        if (title.toLowerCase().includes('captcha') || url.toLowerCase().includes('captcha')) {
            console.log(`[Crawl] Captcha detected! Title: "${title}", URL: "${url}"`);
            
            // Send error API
            const errorResponse = await fetch(`${DOMAIN}api/ggsheet/updateCrawlStatus`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: sheetId,
                    link: currentLink,
                    signature: signature || 'unknown',
                    errors: 'Captcha'
                })
            });
            
            if (errorResponse.ok) {
                console.log('[Crawl] Captcha error sent to API successfully');
                const responseData = await errorResponse.json();
                console.log('[Crawl] API Response:', responseData);
            } else {
                console.error('[Crawl] Failed to send Captcha error to API, status:', errorResponse.status);
            }
            
            return true; // Captcha detected
        }
        
        return false; // No Captcha
    } catch (error) {
        console.error('[Crawl] Error checking Captcha:', error);
        return false;
    }
}

 // Function to crawl a single tab (for sheet-based crawling)
     async function crawlSingleTab(tabId, diskSerialNumber, linkIndex, currentLink, linkSheetId) {
    try {
        console.log(`[Crawl] Starting crawl for tab ${tabId}, link ${linkIndex}`);
        
        // Wait a bit more for page to fully load
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (!isCrawlingAli) return false; // Check after page load wait
        
        // Check for Captcha immediately when starting crawl
        const hasCaptcha = await checkCaptchaAndSendError(tabId, linkSheetId, currentLink, '');
        if (!isCrawlingAli) return false; // Check after captcha check
        
        if (hasCaptcha) {
            console.log(`[Crawl] Captcha detected at start of crawl, stopping immediately`);
            chrome.runtime.sendMessage({ 
                type: 'UPDATE_STATUS', 
                data: { 
                    linkUrl: currentLink,
                    pageStatus: `Captcha detected - stopping crawl immediately`, 
                    isTaskRunning: true, 
                    currentPage: linkIndex 
                } 
            });
            return false; // Stop crawling this link
        }
        
        let allProductIds = [];
        let signature = null;
        let page = 1;
        let isStore = false;
        let totalSent = 0;
        let crawlType = 'search';
        let baseUrl = '';
        let isFirstPage = true;
        
                 while (isCrawlingAli) {
             console.log(`[Crawl] Link ${linkIndex}: Crawling page ${page}, isCrawlingAli = ${isCrawlingAli}`);
             
             // Update crawl state with current page
             await saveCrawlState({
                 isCrawling: true,
                 currentLink: currentLink,
                 currentPage: page,
                 totalLinks: 1, // For single link crawling
                 currentLinkIndex: linkIndex,
                 tabTitle: 'Current Tab'
             });
             
             // Check for Captcha before each page
             const hasCaptchaOnPage = await checkCaptchaAndSendError(tabId, linkSheetId, currentLink, signature || '');
             
             if (hasCaptchaOnPage) {
                 console.log(`[Crawl] Captcha detected on page ${page}, stopping crawl for this link`);
                 chrome.runtime.sendMessage({ 
                     type: 'UPDATE_STATUS', 
                     data: { 
                         linkUrl: currentLink,
                         pageStatus: `Captcha detected on page ${page} - stopping crawl`, 
                         isTaskRunning: true, 
                         currentPage: linkIndex 
                     } 
                 });
                 return false; // Stop crawling this link
             }
             
             chrome.runtime.sendMessage({ 
                 type: 'UPDATE_STATUS', 
                 data: { 
                     linkUrl: currentLink,
                     pageStatus: `Crawling page ${page}...`, 
                     isTaskRunning: true, 
                     currentPage: linkIndex 
                 } 
             });

            // Xác định signature trước khi kiểm tra API
            if (isFirstPage) {
                // Xác định isStore dựa vào url hiện tại
                const urlResults = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => window.location.href
                });
                
                if (urlResults && urlResults[0] && urlResults[0].result) {
                    const currentUrl = urlResults[0].result;
                    isStore = currentUrl.includes('/store/');
                    
                    // For store pages, refresh to ensure we start from page 1
                    if (isStore && currentUrl.includes('/pages/all-items.html')) {
                        console.log(`[Crawl] Refreshing store page to start from page 1: ${currentUrl}`);
                        await chrome.tabs.reload(tabId);
                        if (!isCrawlingAli) return false; // Check after reload
                        
                        // Wait for page to load after refresh
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        if (!isCrawlingAli) return false; // Check after refresh wait
                    }
                    
                    if (!isStore) {
                        let url = new URL(currentUrl);
                        url.searchParams.delete('page');
                        baseUrl = url.toString();
                    }
                }
                isFirstPage = false;
            }

            // Lấy signature tạm thời để kiểm tra API (nếu chưa có signature thì skip kiểm tra)
            let tempSignature = signature;
            if (!tempSignature) {
                // Lấy signature bằng cách inject script lấy nhanh signature (không cần lấy productIds)
                const sigRes = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        // Lấy signature như logic cũ
                        let signature = null;
                        const storeA = Array.from(document.querySelectorAll('a[data-href*=".aliexpress."]')).find(a => {
                            const m = a.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                            return m;
                        });
                        if (storeA) {
                            const m = storeA.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                            const storeId = m[1];
                            let text = storeA.innerText || storeA.textContent || '';
                            text = text.trim().toLowerCase().replace(/\s+/g, '_');
                            signature = `${storeId}_${text}`;
                        } else {
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
                                const flagClass = classList.find(cls => cls.startsWith('country-flag-'));
                                if (flagClass) {
                                    const parts = flagClass.split(' ');
                                    countryFlag = parts[parts.length - 1].replace('country-flag-', '').toUpperCase();
                                    if (!countryFlag || countryFlag.length !== 2) {
                                        const last = classList[classList.length - 1];
                                        if (last.length === 2) countryFlag = last.toUpperCase();
                                    }
                                } else {
                                    const last = classList[classList.length - 1];
                                    if (last.length === 2) countryFlag = last.toUpperCase();
                                }
                            }
                            const langSpan = shipTo.querySelector('.ship-to--small--1wG1oGl');
                            if (langSpan) {
                                const langText = langSpan.textContent || '';
                                const match = langText.match(/\/([A-Z]{2})\//);
                                if (match) {
                                    language = match[1];
                                } else {
                                    const fallback = langText.match(/([A-Z]{2})\/?$/);
                                    if (fallback) language = fallback[1];
                                }
                            }
                        }
                        if (signature && countryFlag && language && !signature.match(/_[A-Z]{2}_[A-Z]{2}$/)) {
                            signature = `${signature}_${countryFlag}_${language}`;
                        }
                        return signature;
                    }
                });
                tempSignature = sigRes && sigRes[0] && sigRes[0].result ? sigRes[0].result : null;
                if (tempSignature && !signature) signature = tempSignature;
            }

            let pageToCrawl = page;
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
                            const items = document.querySelectorAll('div.lazy-load');
                            if (items && items.length > 0) {
                                items[items.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                            } 
                        }
                    });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    // Kiểm tra còn item lazy-load không
                    let lazyCountRes = await chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => {
                            const items = document.querySelectorAll('div.lazy-load');
                            if (items) {
                                return items.length;
                            }
                            return 0;
                        }
                    });
                    const lazyCount = lazyCountRes && lazyCountRes[0] && lazyCountRes[0].result ? lazyCountRes[0].result : 0;
                    console.log(`[Crawl] After scroll ${tries + 1}, lazy-load items left: ${lazyCount}`);
                    if (lazyCount === 0) {
                        // Sau khi hết lazy-load, tiếp tục scroll đến khi tìm thấy ul.comet-pagination (phân trang)
                        let foundPaging = false;
                        let pagingTries = 0;
                        let maxPagingTries = 20;
                        while (!foundPaging && pagingTries < maxPagingTries) {
                            const pagingRes = await chrome.scripting.executeScript({
                                target: { tabId },
                                func: () => {
                                    return !!document.querySelector('ul.comet-pagination');
                                }
                            });
                            foundPaging = pagingRes;
                            if (foundPaging) {
                                console.log('[Crawl] Found paging element <ul class="comet-pagination">');
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
            // Thêm delay để đảm bảo trang load đầy đủ sau khi scroll
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check for Captcha before extracting products
            const hasCaptchaOnExtract = await checkCaptchaAndSendError(tabId, linkSheetId, currentLink, signature || '');
            
            if (hasCaptchaOnExtract) {
                console.log(`[Crawl] Captcha detected on page ${page}, stopping crawl for this link`);
                chrome.runtime.sendMessage({ 
                    type: 'UPDATE_STATUS', 
                    data: { 
                        linkUrl: currentLink,
                        pageStatus: `Captcha detected on page ${page} - stopping crawl`, 
                        isTaskRunning: true, 
                        currentPage: linkIndex 
                    } 
                });
                break; // Stop crawling this link
            }
            
            console.log(`[Crawl] Starting to extract product IDs for page ${page}`);
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    let productIds = [];
                    if (window.location.href.includes('/store/')) {
                        // STORE: lấy toàn bộ thẻ a trên trang
                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        const regex = /\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/item\/(\d+)\.html/;
                        const ids = anchors.map(a => {
                            const m = a.getAttribute('href').match(regex);
                            return m ? m[1] : null;
                        }).filter(Boolean);
                        productIds = Array.from(new Set(ids));
                    } else {
                        // SEARCH: chỉ lấy trong #card-list
                        const cardList = document.querySelector('div[data-spm="main"]#card-list');
                        if (cardList) {
                            console.log(`[cardList] found!`);
                            const anchors = Array.from(cardList.querySelectorAll('a[href]'));
                            console.log(`[Link found] ${anchors.length}!`);
                            const regex = /\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/item\/(\d+)\.html/;
                            const ids = anchors.map(a => {
                                const m = a.getAttribute('href').match(regex);
                                return m ? m[1] : null;
                            }).filter(Boolean);
                            console.log(`[ID found] ${ids.length}!`);
                            productIds = Array.from(new Set(ids));
                        } else {
                            console.log(`[cardList] not found!`);
                        }
                    }
                    // Get signature
                    let signature = null;
                    // 1. Try to find any aliexpress store link
                    const storeA = Array.from(document.querySelectorAll('a[data-href*=".aliexpress."]')).find(a => {
                        const m = a.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
                        return m;
                    });
                    if (storeA) {
                        const m = storeA.getAttribute('data-href').match(/\/\/[^\/]*\.aliexpress\.[a-z0-9.-]+\/store\/(\d+)/);
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
                            // Tìm text node chứa "/60" hoặc tương tự
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
            // Always call API even if no products found
            if (signature) {
                console.log('[pushAliexProducts] Payload:', {
                    signature, 
                    listProducts: productIds, 
                    diskSerialNumber: diskSerialNumber,
                    totalPage: totalPageValue,
                    pageNumber: pageIndex
                });
                                                                   const apiRes = await fetch(`${DOMAIN}api/ggsheet/pushAliexProducts`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ 
                          signature, 
                          listProducts: productIds, 
                          diskSerialNumber: diskSerialNumber,
                          totalPage: totalPageValue,
                          pageNumber: pageIndex,
                          linkSheetId: linkSheetId,
                          linkCrawling: currentLink
                      })
                  });
                if (!isCrawlingAli) break;
                if (!apiRes.ok) {
                    console.error(`[Crawl] API request failed at page ${page} for link ${linkIndex}`);
                    break;
                }
                totalSent += productIds.length;
                
                // If no products found, stop crawling
                if (productIds.length === 0) {
                    console.log(`[Crawl] No products found on page ${page}, stopping crawl for this link`);
                    break;
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
                // Kiểm tra xem có trang tiếp theo không dựa trên cấu trúc phân trang mới
                const nextPageRes = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        // Kiểm tra xem có nút "next" không bị disabled
                        const nextButton = document.querySelector('.comet-pagination-next:not(.comet-pagination-disabled)');
                        if (nextButton) {
                            return true;
                        }
                        // Kiểm tra xem có trang tiếp theo trong danh sách không
                        const currentPage = document.querySelector('.comet-pagination-item-active');
                        if (currentPage) {
                            const currentPageNumber = parseInt(currentPage.textContent);
                            const allPageItems = Array.from(document.querySelectorAll('.comet-pagination-item'));
                            const maxPageNumber = Math.max(...allPageItems.map(item => {
                                const num = parseInt(item.textContent);
                                return isNaN(num) ? 0 : num;
                            }));
                            return currentPageNumber < maxPageNumber;
                        }
                        return false;
                    }
                });
                hasNext = nextPageRes && nextPageRes[0] && nextPageRes[0].result;
            }
            if (!hasNext) break;
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!isCrawlingAli) break;
            page++;
        }
        
        allProductIds = Array.from(new Set(allProductIds));
        console.log(`[Crawl] Completed crawling link ${linkIndex}, found ${allProductIds.length} products, sent ${totalSent} products`);
        return true;
        
    } catch (error) {
        console.error(`[Crawl] Error crawling tab ${tabId}:`, error);
        return false;
    }
}