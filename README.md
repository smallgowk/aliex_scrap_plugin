# Get Aliex TrackingNumber Chrome Extension

A Chrome extension that allows you to select Excel template files, input files, and output directories for processing tracking numbers from AliExpress.

## Features

- Select Excel template file (.xlsx)
- Select input Excel file (.xlsx)
- Choose output directory
- Modern and user-friendly interface

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your Chrome toolbar

## Usage

1. Click the extension icon in your Chrome toolbar
2. Select your Excel template file (.xlsx)
3. Select your input Excel file (.xlsx)
4. Choose the output directory where processed files will be saved
5. Click the "Process Files" button to start processing

## Development

The extension consists of the following files:
- `manifest.json`: Extension configuration
- `popup.html`: User interface
- `popup.js`: Extension logic
- `styles.css`: Styling

## Permissions

This extension requires the following permissions:
- File system access for reading and writing files
- Storage for saving user preferences 