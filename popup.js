// Popup script with Start/Stop functionality
function initializeExtension() {
    console.log('Initializing extension...');
    
    const crawlButton = document.getElementById('crawlButton');
    const crawlStatus = document.getElementById('crawlStatus');
    const sheetNameInput = document.getElementById('sheetNameInput');

    // Load sheetName from localStorage nếu có
    if (sheetNameInput) {
        const savedSheetName = localStorage.getItem('sheetName');
        if (savedSheetName) {
            sheetNameInput.value = savedSheetName;
        }
        // Lưu lại mỗi khi người dùng thay đổi
        sheetNameInput.addEventListener('input', function() {
            localStorage.setItem('sheetName', sheetNameInput.value);
        });
    }

    // Check if required elements exist
    if (!crawlButton || !crawlStatus) {
        console.error('Missing required elements:', {
            crawlButton: !!crawlButton,
            crawlStatus: !!crawlStatus
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
            if (typeof message.data.currentPage === 'number' && message.data.isTaskRunning) {
                crawlStatus.textContent = `Crawling page ${message.data.currentPage}...`;
            } else {
                crawlStatus.textContent = message.data.status || `Crawling page ...`;
            }
            updateButtonState(!!message.data.isTaskRunning);
        } else if (message.type === 'CRAWL_COMPLETE') {
            crawlStatus.textContent = `Crawling completed. Found ${message.data.totalItems} items in total`;
            updateButtonState(false);
        } else if (message.type === 'EXPORT_COMPLETE') {
            crawlStatus.textContent = `Found ${message.data.totalItems} unique items. File saved to Downloads folder as ${message.data.fileName}`;
            updateButtonState(false);
        } else if (message.type === 'CRAWL_ERROR' || message.type === 'EXPORT_ERROR') {
            crawlStatus.textContent = `Error: ${message.error}`;
            updateButtonState(false);
        }
    });

    // Handle button click (Start/Stop toggle)
    crawlButton.addEventListener('click', async function() {
        if (isTaskRunning) {
            // Stop the task
            crawlStatus.textContent = 'Stopping...';
            try {
                // Luôn kiểm tra trạng thái thực tế từ background
                chrome.runtime.sendMessage({ type: 'GET_CURRENT_STATUS' }, async function(status) {
                    if (status && status.isTaskRunning) {
                        const response = await chrome.runtime.sendMessage({
                            type: 'STOP_CRAWL_ALIEX_PRODUCTS'
                        });
                        if (response && response.success) {
                            crawlStatus.textContent = 'Stopped by user';
                            updateButtonState(false);
                        } else {
                            crawlStatus.textContent = 'Failed to stop task';
                        }
                    } else {
                        crawlStatus.textContent = 'No crawling task is running.';
                        updateButtonState(false);
                    }
                });
            } catch (error) {
                crawlStatus.textContent = 'Error stopping task: ' + error.message;
                updateButtonState(false);
            }
        } else {
            // Start the task
            crawlStatus.textContent = 'Crawling Aliexpress products...';
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab || !tab.id) throw new Error('Cannot find current tab');
                const diskSerialInput = document.getElementById('sheetNameInput');
                const diskSerialNumber = diskSerialInput && diskSerialInput.value ? diskSerialInput.value.trim() : '';
                if (!diskSerialNumber) {
                    crawlStatus.textContent = 'Disk Serial Number must not be empty!';
                    updateButtonState(false);
                    return;
                }
                // Send new message to background
                const response = await chrome.runtime.sendMessage({
                    type: 'CRAWL_ALIEX_PRODUCTS',
                    diskSerialNumber,
                    tabId: tab.id
                });
                if (response && response.success === false) {
                    crawlStatus.textContent = response.message || 'Crawl failed';
                    updateButtonState(false);
                } else {
                    updateButtonState(true);
                }
            } catch (error) {
                crawlStatus.textContent = 'Error: ' + error.message;
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
        const crawlButton = document.getElementById('crawlButton');
        
        if (status && status.isTaskRunning && typeof status.currentPage === 'number') {
            crawlStatus.textContent = `Crawling page ${status.currentPage}...`;
        } else if (status && status.status && crawlStatus) {
            crawlStatus.textContent = status.status;
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