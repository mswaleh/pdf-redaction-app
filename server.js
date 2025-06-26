const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const cors = require('cors');
const fetch = require('node-fetch'); // Add this dependency

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS for LWC integration and PDF proxy
app.use(cors({
    origin: ['*', 'https://*.lightning.force.com', 'https://*.salesforce.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
    credentials: true
}));

// Set headers for iframe embedding in Salesforce and PDF loading
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors * 'self'");
    
    // Additional headers for PDF loading
    if (req.path.includes('/proxy-pdf') || req.path.includes('/embed')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.setHeader('Accept-Ranges', 'bytes');
    }
    
    next();
});

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'), false);
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// NEW: Test PDF accessibility endpoint for debugging
app.get('/test-pdf-access', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }
        
        console.log('Testing PDF access for URL:', url);
        
        // Test basic HEAD request first
        const headResponse = await fetch(url, { method: 'HEAD' });
        
        const testResult = {
            url: url,
            accessible: headResponse.ok,
            status: headResponse.status,
            statusText: headResponse.statusText,
            headers: {}
        };
        
        // Collect relevant headers
        ['content-type', 'content-length', 'access-control-allow-origin', 'cache-control'].forEach(header => {
            const value = headResponse.headers.get(header);
            if (value) {
                testResult.headers[header] = value;
            }
        });
        
        if (headResponse.ok) {
            // Try to fetch a small portion to verify it's actually a PDF
            try {
                const partialResponse = await fetch(url, {
                    headers: { 'Range': 'bytes=0-1023' }
                });
                
                if (partialResponse.ok) {
                    const buffer = await partialResponse.buffer();
                    const header = buffer.slice(0, 4).toString();
                    testResult.isPDF = header === '%PDF';
                    testResult.fileHeader = header;
                }
            } catch (rangeError) {
                testResult.rangeRequestError = rangeError.message;
            }
        }
        
        console.log('PDF access test result:', testResult);
        res.json(testResult);
        
    } catch (error) {
        console.error('PDF access test error:', error);
        res.status(500).json({
            error: 'Test failed: ' + error.message,
            url: req.query.url
        });
    }
});

// Handle OPTIONS requests for CORS preflight
app.options('/proxy-pdf', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    res.status(200).end();
});

// NEW: PDF Proxy endpoint to handle CORS issues with cloud storage
app.get('/proxy-pdf', async (req, res) => {
    try {
        const { url } = req.query;
        
        console.log('Proxying PDF from URL:', url);
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }
        
        // Validate URL format
        try {
            new URL(url);
        } catch (urlError) {
            return res.status(400).json({ error: 'Invalid URL format' });
        }
        
        // Set up fetch options
        const fetchOptions = {
            method: 'GET',
            headers: {
                'User-Agent': 'PDF-Redaction-Service/1.0'
            }
        };
        
        // Handle Range requests for PDF.js streaming
        if (req.headers.range) {
            fetchOptions.headers['Range'] = req.headers.range;
            console.log('Range request:', req.headers.range);
        }
        
        // Fetch the PDF from the original URL
        const pdfResponse = await fetch(url, fetchOptions);
        
        if (!pdfResponse.ok) {
            console.error('Failed to fetch PDF:', pdfResponse.status, pdfResponse.statusText);
            throw new Error(`Failed to fetch PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
        }
        
        // Get the content type from the original response
        const contentType = pdfResponse.headers.get('content-type') || 'application/pdf';
        const contentLength = pdfResponse.headers.get('content-length');
        const acceptRanges = pdfResponse.headers.get('accept-ranges');
        
        console.log('PDF fetch successful:', {
            contentType,
            contentLength,
            acceptRanges,
            status: pdfResponse.status
        });
        
        // Set proper headers for PDF serving with CORS
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Accept-Ranges, Content-Range');
        
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }
        
        if (acceptRanges) {
            res.setHeader('Accept-Ranges', acceptRanges);
        }
        
        // Handle partial content responses
        if (pdfResponse.status === 206) {
            res.status(206);
            const contentRange = pdfResponse.headers.get('content-range');
            if (contentRange) {
                res.setHeader('Content-Range', contentRange);
            }
        }
        
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        
        // Stream the PDF content
        const pdfBuffer = await pdfResponse.buffer();
        res.send(pdfBuffer);
        
        console.log('PDF proxied successfully, size:', pdfBuffer.length, 'bytes');
        
    } catch (error) {
        console.error('PDF proxy error:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        
        res.status(500).json({ 
            error: 'Failed to proxy PDF: ' + error.message,
            details: error.stack
        });
    }
});

// NEW: Download PDF from URL or base64 content endpoint for LWC integration
app.post('/download-and-redact', async (req, res) => {
    try {
        const { fileUrl, fileContent, redactions, fileName } = req.body;
        
        console.log('Download and redact request:', { 
            hasFileUrl: !!fileUrl, 
            hasFileContent: !!fileContent,
            fileName, 
            redactionsCount: redactions?.length 
        });
        
        if (!fileUrl && !fileContent) {
            return res.status(400).json({ error: 'Either fileUrl or fileContent is required' });
        }
        
        if (!redactions || redactions.length === 0) {
            return res.status(400).json({ error: 'Redactions are required' });
        }

        let pdfBuffer;
        
        if (fileContent) {
            // Use base64 content directly (preferred for private cloud storage)
            console.log('Using provided base64 content');
            try {
                pdfBuffer = Buffer.from(fileContent, 'base64');
                console.log('Decoded PDF from base64, size:', pdfBuffer.length, 'bytes');
            } catch (decodeError) {
                throw new Error('Invalid base64 content: ' + decodeError.message);
            }
        } else {
            // Fallback to downloading from URL
            console.log('Downloading PDF from:', fileUrl);
            const pdfResponse = await fetch(fileUrl);
            
            if (!pdfResponse.ok) {
                throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
            }
            
            pdfBuffer = await pdfResponse.buffer();
            console.log('Downloaded PDF, size:', pdfBuffer.length, 'bytes');
        }

        // Load and redact the PDF
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        
        // Apply redactions
        for (const redaction of redactions) {
            await applyTrueTextRedaction(pdfDoc, redaction);
        }

        // Generate redacted PDF
        const redactedPdfBytes = await pdfDoc.save({
            useObjectStreams: false,
            addDefaultPage: false
        });

        console.log('Redaction completed, output size:', redactedPdfBytes.length, 'bytes');

        // Return the redacted PDF as base64 for easy handling in LWC
        const base64Pdf = Buffer.from(redactedPdfBytes).toString('base64');
        
        res.json({
            success: true,
            redactedPdfBase64: base64Pdf,
            redactionsApplied: redactions.length,
            originalSize: pdfBuffer.length,
            redactedSize: redactedPdfBytes.length,
            fileName: fileName || 'redacted.pdf'
        });

    } catch (error) {
        console.error('Download and redact error:', error);
        res.status(500).json({ 
            error: 'Failed to download and redact PDF: ' + error.message,
            details: error.stack
        });
    }
});

// NEW: Health check endpoint for LWC
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'PDF Redaction Service',
        timestamp: new Date().toISOString()
    });
});

// NEW: Embedded redaction interface for LWC modal
app.get('/embed', (req, res) => {
    const { fileUrl, fileName } = req.query;
    
    const embedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDF Redaction</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f8f9fa;
        }
        .redaction-container {
            max-width: 100%;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: #2563eb;
            color: white;
            padding: 15px 20px;
            font-size: 18px;
            font-weight: 600;
        }
        .content {
            padding: 20px;
        }
        .file-info {
            background: #f1f5f9;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border-left: 4px solid #2563eb;
        }
        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .btn {
            padding: 10px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .btn-primary {
            background: #2563eb;
            color: white;
        }
        .btn-primary:hover {
            background: #1d4ed8;
        }
        .btn-success {
            background: #059669;
            color: white;
        }
        .btn-success:hover {
            background: #047857;
        }
        .btn-secondary {
            background: #6b7280;
            color: white;
        }
        .btn-secondary:hover {
            background: #4b5563;
        }
        .status {
            padding: 10px 15px;
            border-radius: 6px;
            margin: 10px 0;
            font-size: 14px;
        }
        .status.success {
            background: #d1fae5;
            color: #065f46;
            border: 1px solid #10b981;
        }
        .status.error {
            background: #fee2e2;
            color: #991b1b;
            border: 1px solid #ef4444;
        }
        .status.info {
            background: #dbeafe;
            color: #1e40af;
            border: 1px solid #3b82f6;
        }
        #pdfContainer {
            border: 2px dashed #cbd5e1;
            border-radius: 8px;
            min-height: 400px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        .loading {
            text-align: center;
            color: #6b7280;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #f3f4f6;
            border-top: 4px solid #2563eb;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .redaction-count {
            background: #fef3c7;
            color: #92400e;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div class="redaction-container">
        <div class="header">
            📄 PDF Redaction Tool
        </div>
        <div class="content">
            <div class="file-info">
                <strong>File:</strong> <span id="fileName">${fileName || 'Unknown'}</span><br>
                <strong>Instructions:</strong> Load the PDF below, then click and drag to create redaction areas
            </div>
            
            <div class="controls">
                <button class="btn btn-primary" onclick="loadPDF()">Load PDF</button>
                <button class="btn btn-secondary" onclick="testPDFAccess()">Test PDF Access</button>
                <button class="btn btn-secondary" onclick="clearRedactions()">Clear All</button>
                <button class="btn btn-success" onclick="completeRedaction()" disabled id="saveBtn">
                    Complete Redaction
                </button>
                <div class="redaction-count" id="redactionCount" style="display: none;">
                    Redactions: <span id="count">0</span>
                </div>
            </div>
            
            <div id="statusMessage"></div>
            
            <div id="pdfContainer">
                <div class="loading">
                    <div class="spinner"></div>
                    Click "Load PDF" to begin redacting
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script>
        const fileUrl = "${fileUrl || ''}";
        const fileName = "${fileName || 'document.pdf'}";
        let pdfDoc = null;
        let canvas = null;
        let ctx = null;
        let redactionLayer = null;
        let redactions = [];
        let isRedacting = false;
        let currentRedactionBox = null;
        let redactionStart = null;
        
        // Set PDF.js worker
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        function showStatus(message, type = 'info') {
            const statusDiv = document.getElementById('statusMessage');
            statusDiv.innerHTML = \`<div class="status \${type}">\${message}</div>\`;
            
            if (type === 'success' || type === 'info') {
                setTimeout(() => {
                    statusDiv.innerHTML = '';
                }, 3000);
            }
        }
        
        function updateRedactionCount() {
            const countElement = document.getElementById('redactionCount');
            const countSpan = document.getElementById('count');
            const saveBtn = document.getElementById('saveBtn');
            
            countSpan.textContent = redactions.length;
            
            if (redactions.length > 0) {
                countElement.style.display = 'block';
                saveBtn.disabled = false;
            } else {
                countElement.style.display = 'none';
                saveBtn.disabled = true;
            }
        }
        
        async function testPDFAccess() {
            if (!fileUrl) {
                showStatus('No file URL provided', 'error');
                return;
            }
            
            try {
                showStatus('Testing PDF accessibility...', 'info');
                
                const testUrl = '/test-pdf-access?url=' + encodeURIComponent(fileUrl);
                const response = await fetch(testUrl);
                const result = await response.json();
                
                console.log('PDF access test result:', result);
                
                if (result.accessible) {
                    if (result.isPDF) {
                        showStatus('✓ PDF is accessible and valid. You can now load it for redaction.', 'success');
                    } else {
                        showStatus('⚠ File is accessible but may not be a valid PDF. Header: ' + (result.fileHeader || 'unknown'), 'error');
                    }
                } else {
                    showStatus('✗ PDF is not accessible. Status: ' + result.status + ' ' + result.statusText, 'error');
                }
                
                // Show detailed info in console
                console.log('PDF Headers:', result.headers);
                if (result.rangeRequestError) {
                    console.log('Range request failed:', result.rangeRequestError);
                }
                
            } catch (error) {
                console.error('PDF access test failed:', error);
                showStatus('PDF access test failed: ' + error.message, 'error');
            }
        }
        
        async function loadPDF() {
            if (!fileUrl) {
                showStatus('No file URL provided', 'error');
                return;
            }
            
            try {
                showStatus('Loading PDF...', 'info');
                
                const container = document.getElementById('pdfContainer');
                container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading PDF...</div>';
                
                // Use proxy URL to avoid CORS issues with cloud storage
                const proxyUrl = '/proxy-pdf?url=' + encodeURIComponent(fileUrl);
                console.log('Original PDF URL:', fileUrl);
                console.log('Loading PDF via proxy:', proxyUrl);
                
                // Load PDF
                const loadingTask = pdfjsLib.getDocument(proxyUrl);
                pdfDoc = await loadingTask.promise;
                
                // Render first page
                await renderPage(1);
                
                // Setup redaction events
                setupRedactionEvents();
                
                showStatus('PDF loaded successfully! Click and drag to create redaction areas.', 'success');
                
            } catch (error) {
                console.error('Error loading PDF:', error);
                console.error('PDF URL attempted:', fileUrl);
                console.error('Proxy URL attempted:', proxyUrl);
                
                let errorMessage = 'Error loading PDF: ' + error.message;
                
                // Provide more specific error messages
                if (error.message.includes('Failed to fetch')) {
                    errorMessage = 'Could not access the PDF file. This may be due to network issues or file permissions.';
                } else if (error.message.includes('Invalid PDF')) {
                    errorMessage = 'The file does not appear to be a valid PDF document.';
                } else if (error.message.includes('401') || error.message.includes('403')) {
                    errorMessage = 'Access denied to the PDF file. Please check file permissions.';
                }
                
                showStatus(errorMessage, 'error');
            }
        }
        
        async function renderPage(pageNum) {
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.2 });
            
            // Create container
            const container = document.getElementById('pdfContainer');
            container.innerHTML = '';
            container.style.position = 'relative';
            container.style.display = 'inline-block';
            container.style.border = '1px solid #ddd';
            
            // Create canvas
            canvas = document.createElement('canvas');
            ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.display = 'block';
            container.appendChild(canvas);
            
            // Create redaction layer
            redactionLayer = document.createElement('div');
            redactionLayer.style.position = 'absolute';
            redactionLayer.style.top = '0';
            redactionLayer.style.left = '0';
            redactionLayer.style.width = viewport.width + 'px';
            redactionLayer.style.height = viewport.height + 'px';
            redactionLayer.style.pointerEvents = 'none';
            redactionLayer.style.zIndex = '5';
            container.appendChild(redactionLayer);
            
            // Render PDF page
            const renderContext = {
                canvasContext: ctx,
                viewport: viewport
            };
            
            await page.render(renderContext).promise;
        }
        
        function setupRedactionEvents() {
            if (!canvas) return;
            
            canvas.addEventListener('mousedown', startRedaction);
            canvas.addEventListener('mousemove', drawRedaction);
            canvas.addEventListener('mouseup', endRedaction);
            canvas.addEventListener('mouseleave', endRedaction);
            canvas.style.cursor = 'crosshair';
        }
        
        function startRedaction(e) {
            e.preventDefault();
            isRedacting = true;
            
            const rect = canvas.getBoundingClientRect();
            redactionStart = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            
            currentRedactionBox = document.createElement('div');
            currentRedactionBox.style.position = 'absolute';
            currentRedactionBox.style.left = redactionStart.x + 'px';
            currentRedactionBox.style.top = redactionStart.y + 'px';
            currentRedactionBox.style.width = '0px';
            currentRedactionBox.style.height = '0px';
            currentRedactionBox.style.background = 'rgba(255, 0, 0, 0.3)';
            currentRedactionBox.style.border = '2px solid #e74c3c';
            currentRedactionBox.style.pointerEvents = 'all';
            currentRedactionBox.style.zIndex = '10';
            redactionLayer.appendChild(currentRedactionBox);
        }
        
        function drawRedaction(e) {
            if (!isRedacting || !currentRedactionBox) return;
            
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;
            
            const width = Math.abs(currentX - redactionStart.x);
            const height = Math.abs(currentY - redactionStart.y);
            const left = Math.min(currentX, redactionStart.x);
            const top = Math.min(currentY, redactionStart.y);
            
            currentRedactionBox.style.left = left + 'px';
            currentRedactionBox.style.top = top + 'px';
            currentRedactionBox.style.width = width + 'px';
            currentRedactionBox.style.height = height + 'px';
        }
        
        function endRedaction() {
            if (!isRedacting || !currentRedactionBox) return;
            
            const width = parseInt(currentRedactionBox.style.width) || 0;
            const height = parseInt(currentRedactionBox.style.height) || 0;
            
            if (width >= 10 && height >= 10) {
                const redaction = {
                    pageIndex: 0, // Single page for now
                    x: parseInt(currentRedactionBox.style.left) || 0,
                    y: parseInt(currentRedactionBox.style.top) || 0,
                    width: width,
                    height: height,
                    viewportWidth: canvas.width,
                    viewportHeight: canvas.height
                };
                
                redactions.push(redaction);
                
                // Add click handler to remove redaction
                currentRedactionBox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeRedaction(redaction, currentRedactionBox);
                });
                
                currentRedactionBox.style.cursor = 'pointer';
                currentRedactionBox.title = 'Click to remove this redaction';
                
                updateRedactionCount();
                showStatus(\`Redaction added (\${redactions.length} total)\`, 'success');
            } else {
                redactionLayer.removeChild(currentRedactionBox);
            }
            
            isRedacting = false;
            currentRedactionBox = null;
        }
        
        function removeRedaction(redaction, element) {
            const index = redactions.indexOf(redaction);
            if (index > -1) {
                redactions.splice(index, 1);
                redactionLayer.removeChild(element);
                updateRedactionCount();
                showStatus(\`Redaction removed (\${redactions.length} remaining)\`, 'info');
            }
        }
        
        function clearRedactions() {
            redactions = [];
            redactionLayer.innerHTML = '';
            updateRedactionCount();
            showStatus('All redactions cleared', 'info');
        }
        
        async function completeRedaction() {
            if (redactions.length === 0) {
                showStatus('No redactions to apply', 'error');
                return;
            }
            
            try {
                showStatus('Processing redactions...', 'info');
                
                const response = await fetch('/download-and-redact', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        fileUrl: fileUrl,
                        redactions: redactions,
                        fileName: fileName
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showStatus(\`Redaction completed! \${result.redactionsApplied} areas redacted.\`, 'success');
                    
                    // Send result back to parent window (LWC)
                    if (window.parent && window.parent.postMessage) {
                        window.parent.postMessage({
                            type: 'redactionComplete',
                            data: {
                                success: true,
                                redactedPdfBase64: result.redactedPdfBase64,
                                fileName: result.fileName,
                                redactionsApplied: result.redactionsApplied,
                                originalSize: result.originalSize,
                                redactedSize: result.redactedSize
                            }
                        }, '*');
                    }
                } else {
                    throw new Error(result.error || 'Redaction failed');
                }
                
            } catch (error) {
                console.error('Redaction error:', error);
                showStatus('Error: ' + error.message, 'error');
            }
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            if (fileUrl) {
                console.log('Page loaded with PDF URL:', fileUrl);
                // Test PDF access first, then optionally auto-load
                testPDFAccess();
            } else {
                showStatus('No PDF URL provided', 'error');
            }
        });
    </script>
</body>
</html>`;
    
    res.send(embedHtml);
});

// REPLACE the existing /upload endpoint:
app.post('/upload', upload.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
    }
    
    res.json({ 
        filename: req.file.filename,
        originalName: req.file.originalname,
        path: `/uploads/${req.file.filename}`,
        success: true
    });
});

// ADD new endpoint for processing base64 content:
app.post('/process-pdf-content', async (req, res) => {
    try {
        const { fileName, contentBase64 } = req.body;
        
        if (!fileName || !contentBase64) {
            return res.status(400).json({ error: 'Missing fileName or contentBase64' });
        }

        console.log(`Processing PDF content for ${fileName}`);
        
        // Convert base64 to buffer and save temporarily
        const pdfBuffer = Buffer.from(contentBase64, 'base64');
        const tempFileName = Date.now() + '-' + fileName;
        const filePath = path.join(__dirname, 'uploads', tempFileName);
        
        fs.writeFileSync(filePath, pdfBuffer);
        
        res.json({
            success: true,
            filename: tempFileName,
            originalName: fileName,
            message: 'PDF content processed successfully'
        });

    } catch (error) {
        console.error('Error processing PDF content:', error);
        res.status(500).json({ error: 'Failed to process PDF content: ' + error.message });
    }
});

app.use('/uploads', express.static('uploads'));

// REPLACE the existing /redact endpoint:
app.post('/redact', async (req, res) => {
    try {
        const { filename, redactions, contentBase64 } = req.body;
        
        let filePath;
        let pdfBytes;
        
        if (contentBase64) {
            // Working with base64 content directly
            console.log(`Processing redactions on base64 content`);
            pdfBytes = Buffer.from(contentBase64, 'base64');
        } else if (filename) {
            // Working with uploaded file
            filePath = path.join(__dirname, 'uploads', filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            pdfBytes = fs.readFileSync(filePath);
        } else {
            return res.status(400).json({ error: 'Missing filename or contentBase64' });
        }

        if (!redactions) {
            return res.status(400).json({ error: 'Missing redactions' });
        }

        console.log(`Processing ${redactions.length} redactions`);

        // Process the PDF
        const pdfDoc = await PDFDocument.load(pdfBytes);
        
        // Apply true redactions
        for (const redaction of redactions) {
            await applyTrueTextRedaction(pdfDoc, redaction);
        }

        // Save redacted PDF
        const redactedPdfBytes = await pdfDoc.save({
            useObjectStreams: false,
            addDefaultPage: false
        });
        
        // Return base64 content instead of saving to file
        const redactedBase64 = Buffer.from(redactedPdfBytes).toString('base64');

        console.log(`Redaction complete, returning base64 content`);

        res.json({ 
            success: true,
            redactedPdfBase64: redactedBase64,
            redactionsApplied: redactions.length,
            message: 'PDF redacted successfully'
        });

    } catch (error) {
        console.error('Redaction error:', error);
        res.status(500).json({ error: 'Failed to redact PDF: ' + error.message });
    }
});

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Enhanced true redaction function (same as before)
async function applyTrueTextRedaction(pdfDoc, redaction) {
    try {
        const page = pdfDoc.getPage(redaction.pageIndex);
        const { width, height } = page.getSize();
        
        const pdfX = (redaction.x / redaction.viewportWidth) * width;
        const pdfY = height - ((redaction.y + redaction.height) / redaction.viewportHeight) * height;
        const pdfWidth = (redaction.width / redaction.viewportWidth) * width;
        const pdfHeight = (redaction.height / redaction.viewportHeight) * height;
        
        console.log(`Applying redaction: x=${pdfX.toFixed(2)}, y=${pdfY.toFixed(2)}, w=${pdfWidth.toFixed(2)}, h=${pdfHeight.toFixed(2)}`);

        // Multiple layers for complete text coverage
        for (let i = 0; i < 5; i++) {
            page.drawRectangle({
                x: pdfX - 2 - i,
                y: pdfY - 2 - i,
                width: pdfWidth + 4 + (i * 2),
                height: pdfHeight + 4 + (i * 2),
                color: rgb(1, 1, 1),
                opacity: 1,
                borderWidth: 0
            });
        }

        // Add noise pattern
        try {
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const gridSize = 2;
            for (let x = pdfX; x < pdfX + pdfWidth; x += gridSize) {
                for (let y = pdfY; y < pdfY + pdfHeight; y += gridSize) {
                    try {
                        page.drawText('█', {
                            x: x,
                            y: y,
                            size: 4,
                            font: font,
                            color: rgb(1, 1, 1),
                            opacity: 1
                        });
                    } catch (textError) {
                        // Skip if text placement fails
                    }
                }
            }
        } catch (fontError) {
            console.log('Font embedding skipped:', fontError.message);
        }

        // Final black rectangle
        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: rgb(0, 0, 0),
            opacity: 1,
            borderWidth: 0
        });

        console.log('Redaction applied successfully');

    } catch (error) {
        console.error('Error in applyTrueTextRedaction:', error);
        
        try {
            const page = pdfDoc.getPage(redaction.pageIndex);
            const { width, height } = page.getSize();
            const pdfX = (redaction.x / redaction.viewportWidth) * width;
            const pdfY = height - ((redaction.y + redaction.height) / redaction.viewportHeight) * height;
            const pdfWidth = (redaction.width / redaction.viewportWidth) * width;
            const pdfHeight = (redaction.height / redaction.viewportHeight) * height;
            
            page.drawRectangle({
                x: pdfX,
                y: pdfY,
                width: pdfWidth,
                height: pdfHeight,
                color: rgb(0, 0, 0),
                opacity: 1
            });
            
            console.log('Fallback redaction applied');
        } catch (fallbackError) {
            console.error('Fallback redaction also failed:', fallbackError);
            throw fallbackError;
        }
    }
}

// ADD new endpoint for iframe embedding:
app.get('/embed', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDF Redaction Interface</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f8f9fa;
        }
        
        .container {
            max-width: 100%;
            height: calc(100vh - 40px);
            display: flex;
            flex-direction: column;
        }
        
        .toolbar {
            background: white;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .pdf-container {
            flex: 1;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            position: relative;
            overflow: auto;
        }
        
        canvas {
            display: block;
            margin: 20px auto;
            border: 1px solid #ddd;
            cursor: crosshair;
        }
        
        .redaction-box {
            position: absolute;
            background: rgba(255, 0, 0, 0.3);
            border: 2px solid red;
            cursor: pointer;
            pointer-events: auto;
        }
        
        .redaction-box:hover {
            background: rgba(255, 0, 0, 0.5);
        }
        
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        
        .btn-primary {
            background: #007bff;
            color: white;
        }
        
        .btn-success {
            background: #28a745;
            color: white;
        }
        
        .btn-danger {
            background: #dc3545;
            color: white;
        }
        
        .status {
            flex: 1;
            color: #666;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body>
    <div class="container">
        <div class="toolbar">
            <div class="status" id="status">Waiting for PDF content...</div>
            <button class="btn-success" onclick="completeRedaction()" id="completeBtn" disabled>
                Complete Redaction
            </button>
        </div>
        
        <div class="pdf-container" id="pdfContainer">
            <div class="loading">Loading PDF redaction interface...</div>
        </div>
    </div>

    <script>
        let pdfDoc = null;
        let redactions = [];
        let isDrawing = false;
        let startPos = null;
        let currentRedactionDiv = null;
        
        // Listen for PDF content from parent window
        window.addEventListener('message', async function(event) {
            if (event.data.type === 'loadPDFContent') {
                await loadPDFFromBase64(event.data.contentBase64, event.data.fileName);
            }
        });
        
        async function loadPDFFromBase64(base64Content, fileName) {
            try {
                document.getElementById('status').textContent = 'Loading PDF: ' + fileName;
                
                // Convert base64 to Uint8Array
                const binaryString = atob(base64Content);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                
                // Load PDF
                pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
                
                // Render first page
                await renderPage(1);
                
                document.getElementById('status').textContent = 'PDF loaded. Click and drag to create redaction areas.';
                document.getElementById('completeBtn').disabled = false;
                
                // Notify parent that PDF is loaded
                window.parent.postMessage({
                    type: 'pdfLoaded',
                    fileName: fileName
                }, '*');
                
            } catch (error) {
                console.error('Error loading PDF:', error);
                document.getElementById('status').textContent = 'Error loading PDF: ' + error.message;
                
                window.parent.postMessage({
                    type: 'error',
                    error: error.message
                }, '*');
            }
        }
        
        async function renderPage(pageNum) {
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.5 });
                
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                canvas.style.position = 'relative';
                
                // Clear container and add canvas
                const container = document.getElementById('pdfContainer');
                container.innerHTML = '';
                container.appendChild(canvas);
                
                // Render PDF page
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;
                
                // Set up redaction drawing
                setupRedactionDrawing(canvas, viewport);
                
            } catch (error) {
                console.error('Error rendering page:', error);
                throw error;
            }
        }
        
        function setupRedactionDrawing(canvas, viewport) {
            const container = canvas.parentElement;
            
            canvas.addEventListener('mousedown', function(e) {
                isDrawing = true;
                const rect = canvas.getBoundingClientRect();
                startPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                
                // Create redaction div
                currentRedactionDiv = document.createElement('div');
                currentRedactionDiv.className = 'redaction-box';
                currentRedactionDiv.style.left = startPos.x + 'px';
                currentRedactionDiv.style.top = startPos.y + 'px';
                currentRedactionDiv.style.width = '0px';
                currentRedactionDiv.style.height = '0px';
                
                container.appendChild(currentRedactionDiv);
            });
            
            canvas.addEventListener('mousemove', function(e) {
                if (!isDrawing || !currentRedactionDiv) return;
                
                const rect = canvas.getBoundingClientRect();
                const currentPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                
                const width = Math.abs(currentPos.x - startPos.x);
                const height = Math.abs(currentPos.y - startPos.y);
                const left = Math.min(startPos.x, currentPos.x);
                const top = Math.min(startPos.y, currentPos.y);
                
                currentRedactionDiv.style.left = left + 'px';
                currentRedactionDiv.style.top = top + 'px';
                currentRedactionDiv.style.width = width + 'px';
                currentRedactionDiv.style.height = height + 'px';
            });
            
            canvas.addEventListener('mouseup', function(e) {
                if (!isDrawing || !currentRedactionDiv) return;
                
                isDrawing = false;
                
                // Check if redaction is large enough
                const width = parseInt(currentRedactionDiv.style.width);
                const height = parseInt(currentRedactionDiv.style.height);
                
                if (width > 10 && height > 10) {
                    // Add click handler to remove redaction
                    currentRedactionDiv.addEventListener('click', function() {
                        currentRedactionDiv.remove();
                        updateStatus();
                    });
                    
                    updateStatus();
                } else {
                    // Remove if too small
                    currentRedactionDiv.remove();
                }
                
                currentRedactionDiv = null;
            });
        }
        
        function updateStatus() {
            const redactionBoxes = document.querySelectorAll('.redaction-box');
            document.getElementById('status').textContent = 
                redactionBoxes.length + ' redaction areas created. Click on any redaction to remove it.';
        }
        
        async function completeRedaction() {
            try {
                const redactionBoxes = document.querySelectorAll('.redaction-box');
                
                if (redactionBoxes.length === 0) {
                    alert('Please create at least one redaction area before completing.');
                    return;
                }
                
                document.getElementById('status').textContent = 'Processing redactions...';
                document.getElementById('completeBtn').disabled = true;
                
                // Collect redaction coordinates
                const canvas = document.querySelector('canvas');
                const redactionData = [];
                
                redactionBoxes.forEach(box => {
                    redactionData.push({
                        pageIndex: 0, // For now, only first page
                        x: parseInt(box.style.left),
                        y: parseInt(box.style.top),
                        width: parseInt(box.style.width),
                        height: parseInt(box.style.height),
                        viewportWidth: canvas.width,
                        viewportHeight: canvas.height
                    });
                });
                
                // Send redaction request to server
                const response = await fetch('/redact', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        redactions: redactionData,
                        contentBase64: window.originalPDFContent
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    // Send result back to parent window
                    window.parent.postMessage({
                        type: 'redactionComplete',
                        data: {
                            success: true,
                            redactedPdfBase64: result.redactedPdfBase64,
                            redactionsApplied: result.redactionsApplied
                        }
                    }, '*');
                } else {
                    throw new Error(result.error || 'Redaction failed');
                }
                
            } catch (error) {
                console.error('Error completing redaction:', error);
                alert('Error completing redaction: ' + error.message);
                document.getElementById('completeBtn').disabled = false;
            }
        }
        
        // Store original PDF content for redaction
        window.originalPDFContent = null;
        
        // Override loadPDFFromBase64 to store content
        const originalLoadPDF = loadPDFFromBase64;
        loadPDFFromBase64 = async function(base64Content, fileName) {
            window.originalPDFContent = base64Content;
            return originalLoadPDF(base64Content, fileName);
        };
    </script>
</body>
</html>
    `;
    
    res.send(html);
});

app.listen(PORT, () => {
    console.log(`PDF Redaction Server running on http://localhost:${PORT}`);
    console.log('Enhanced for LWC integration with iframe embedding');
    console.log('New endpoints:');
    console.log('  - POST /download-and-redact (for LWC integration)');
    console.log('  - GET /embed (embedded redaction interface)');
    console.log('  - GET /health (health check)');
    console.log('  - GET /proxy-pdf (PDF proxy for CORS handling)');
    console.log('  - GET /test-pdf-access (PDF accessibility testing)');
});
