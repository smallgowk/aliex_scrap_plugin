// Popup script with Start/Stop functionality
function initializeExtension() {
    console.log('Initializing extension...');
    
    const crawlButton = document.getElementById('crawlButton');
    const crawlStatus = document.getElementById('crawlStatus');
    const crawlStatusDetail = document.getElementById('crawlStatusDetail');
    const sheetIdInput = document.getElementById('sheetIdInput');
    const diskSerialInput = document.getElementById('diskSerialInput');

    // Load saved values from localStorage
    if (sheetIdInput) {
        const savedSheetId = localStorage.getItem('sheetId');
        if (savedSheetId) {
            sheetIdInput.value = savedSheetId;
        }
        sheetIdInput.addEventListener('input', function() {
            localStorage.setItem('sheetId', sheetIdInput.value);
        });
    }



    if (diskSerialInput) {
        const savedDiskSerial = localStorage.getItem('diskSerialNumber');
        if (savedDiskSerial) {
            diskSerialInput.value = savedDiskSerial;
        }
        diskSerialInput.addEventListener('input', function() {
            localStorage.setItem('diskSerialNumber', diskSerialInput.value);
        });
    }

    // Check if required elements exist
    if (!crawlButton || !crawlStatus || !crawlStatusDetail) {
        console.error('Missing required elements:', {
            crawlButton: !!crawlButton,
            crawlStatus: !!crawlStatus,
            crawlStatusDetail: !!crawlStatusDetail
        });
        return;
    }

    // Track current state
    let isTaskRunning = false;

    // Debug function
    function debug(message, data = null) {
        console.log(`[DEBUG] ${message}`, data);
    }

    // Update button state
    function updateButtonState(running) {
        isTaskRunning = running;
        if (running) {
            crawlButton.textContent = 'Stop';
            crawlButton.style.backgroundColor = '#f44336'; // Red color
        } else {
            crawlButton.textContent = 'Start';
            crawlButton.style.backgroundColor = '#4CAF50'; // Green color
        }
        crawlButton.disabled = false; // Always keep button enabled
    }

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'UPDATE_STATUS') {
            // Always preserve link URL if available
            if (message.data.linkUrl) {
                crawlStatus.textContent = `Crawling link: ${message.data.linkUrl}`;
            } else if (message.data.status) {
                crawlStatus.textContent = message.data.status;
            }
            
            if (message.data.pageStatus) {
                crawlStatusDetail.textContent = message.data.pageStatus;
            } else {
                crawlStatusDetail.textContent = '';
            }
            
            updateButtonState(!!message.data.isTaskRunning);
        } else if (message.type === 'CRAWL_COMPLETE') {
            crawlStatus.textContent = `Crawling completed. Found ${message.data.totalItems} items in total`;
            crawlStatusDetail.textContent = '';
            updateButtonState(false);
        } else if (message.type === 'EXPORT_COMPLETE') {
            crawlStatus.textContent = `Found ${message.data.totalItems} unique items. File saved to Downloads folder as ${message.data.fileName}`;
            crawlStatusDetail.textContent = '';
            updateButtonState(false);
        } else if (message.type === 'CRAWL_ERROR' || message.type === 'EXPORT_ERROR') {
            crawlStatus.textContent = `Error: ${message.error}`;
            crawlStatusDetail.textContent = '';
            updateButtonState(false);
        }
    });

    // Handle button click (Start/Stop toggle)
    crawlButton.addEventListener('click', async function() {
        if (isTaskRunning) {
            // Stop the task
            crawlStatus.textContent = 'Stopping...';
            crawlStatusDetail.textContent = '';
            try {
                // Luôn kiểm tra trạng thái thực tế từ background
                chrome.runtime.sendMessage({ type: 'GET_CURRENT_STATUS' }, async function(status) {
                    if (status && status.isTaskRunning) {
                        const response = await chrome.runtime.sendMessage({
                            type: 'STOP_CRAWL_ALIEX_PRODUCTS'
                        });
                        if (response && response.success) {
                            crawlStatus.textContent = 'Stopped by user';
                            crawlStatusDetail.textContent = '';
                            updateButtonState(false);
                        } else {
                            crawlStatus.textContent = 'Failed to stop task';
                            crawlStatusDetail.textContent = '';
                        }
                    } else {
                        crawlStatus.textContent = 'No crawling task is running.';
                        crawlStatusDetail.textContent = '';
                        updateButtonState(false);
                    }
                });
            } catch (error) {
                crawlStatus.textContent = 'Error stopping task: ' + error.message;
                crawlStatusDetail.textContent = '';
                updateButtonState(false);
            }
        } else {
            // Start the task
            crawlStatus.textContent = 'Starting crawl process...';
            crawlStatusDetail.textContent = '';
            try {
                const sheetId = sheetIdInput && sheetIdInput.value ? sheetIdInput.value.trim() : '';
                const diskSerialNumber = diskSerialInput && diskSerialInput.value ? diskSerialInput.value.trim() : '';
                
                if (!sheetId) {
                    crawlStatus.textContent = 'Link Sheet ID must not be empty!';
                    crawlStatusDetail.textContent = '';
                    updateButtonState(false);
                    return;
                }
                

                
                if (!diskSerialNumber) {
                    crawlStatus.textContent = 'Disk Serial Number must not be empty!';
                    crawlStatusDetail.textContent = '';
                    updateButtonState(false);
                    return;
                }
                
                // Get current active tab for single tab crawling
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                
                if (activeTab && activeTab.url && activeTab.url.includes('aliexpress.com')) {
                    // Single tab crawling - crawl current tab
                    const response = await chrome.runtime.sendMessage({
                        type: 'CRAWL_ALIEX_PRODUCTS',
                        tabId: activeTab.id,
                        sheetId,
                        diskSerialNumber
                    });
                    
                    if (response && response.success === false) {
                        crawlStatus.textContent = response.message || 'Crawl failed';
                        crawlStatusDetail.textContent = '';
                        updateButtonState(false);
                    } else {
                        updateButtonState(true);
                    }
                } else {
                    // Sheet-based crawling - crawl links from sheet
                    const response = await chrome.runtime.sendMessage({
                        type: 'CRAWL_ALIEX_PRODUCTS_FROM_SHEET',
                        sheetId,
                        diskSerialNumber
                    });
                    
                    if (response && response.success === false) {
                        crawlStatus.textContent = response.message || 'Crawl failed';
                        crawlStatusDetail.textContent = '';
                        updateButtonState(false);
                    } else {
                        updateButtonState(true);
                    }
                }
            } catch (error) {
                crawlStatus.textContent = 'Error: ' + error.message;
                crawlStatusDetail.textContent = '';
                updateButtonState(false);
            }
        }
    });

    console.log('Extension initialized successfully');
}

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', function() {
    // Get current status from background
    chrome.runtime.sendMessage({ type: 'GET_CURRENT_STATUS' }, function(status) {
        const crawlStatus = document.getElementById('crawlStatus');
        const crawlStatusDetail = document.getElementById('crawlStatusDetail');
        const crawlButton = document.getElementById('crawlButton');
        
        if (status && status.isTaskRunning) {
            if (status.linkUrl) {
                crawlStatus.textContent = `Crawling link: ${status.linkUrl}`;
            } else {
                crawlStatus.textContent = status.status || '';
            }
            
            if (status.pageStatus) {
                crawlStatusDetail.textContent = status.pageStatus;
            } else {
                crawlStatusDetail.textContent = '';
            }
        } else if (status && status.status && crawlStatus) {
            crawlStatus.textContent = status.status;
            crawlStatusDetail.textContent = '';
        }
        
        // Set initial button state based on task status
        if (crawlButton) {
            const isRunning = !!(status && status.isTaskRunning);
            if (isRunning) {
                crawlButton.textContent = 'Stop';
                crawlButton.style.backgroundColor = '#f44336';
            } else {
                crawlButton.textContent = 'Start';
                crawlButton.style.backgroundColor = '#4CAF50';
            }
            crawlButton.disabled = false;
        }
    });
    
    initializeExtension();
});