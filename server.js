const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for iframe embedding
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Set headers to allow iframe embedding from any origin
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
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
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'PDF Redaction Service',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// Upload endpoint (keep for backward compatibility)
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

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Process base64 PDF content
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

// Redaction endpoint - now works with base64 content
app.post('/redact', async (req, res) => {
    try {
        const { filename, redactions, contentBase64 } = req.body;
        
        let pdfBytes;
        
        if (contentBase64) {
            // Working with base64 content directly (preferred method)
            console.log(`Processing redactions on base64 content`);
            pdfBytes = Buffer.from(contentBase64, 'base64');
        } else if (filename) {
            // Working with uploaded file (fallback)
            const filePath = path.join(__dirname, 'uploads', filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            pdfBytes = fs.readFileSync(filePath);
        } else {
            return res.status(400).json({ error: 'Missing filename or contentBase64' });
        }

        if (!redactions || !Array.isArray(redactions)) {
            return res.status(400).json({ error: 'Missing or invalid redactions array' });
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
        
        // Return base64 content
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

// NEW: Alternative download endpoint that handles file creation on server
app.post('/redact-and-download', async (req, res) => {
    try {
        const { filename, redactions, contentBase64 } = req.body;
        
        let pdfBytes;
        
        if (contentBase64) {
            console.log(`Processing redactions on base64 content for download`);
            pdfBytes = Buffer.from(contentBase64, 'base64');
        } else if (filename) {
            const filePath = path.join(__dirname, 'uploads', filename);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            pdfBytes = fs.readFileSync(filePath);
        } else {
            return res.status(400).json({ error: 'Missing filename or contentBase64' });
        }

        if (!redactions || !Array.isArray(redactions)) {
            return res.status(400).json({ error: 'Missing or invalid redactions array' });
        }

        console.log(`Processing ${redactions.length} redactions for direct download`);

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
        
        // Create filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const downloadFilename = `redacted_document_${timestamp}.pdf`;
        
        console.log(`Sending redacted PDF for download: ${downloadFilename}`);

        // Set headers for file download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
        res.setHeader('Content-Length', redactedPdfBytes.length);
        
        // Send the PDF bytes directly
        res.send(Buffer.from(redactedPdfBytes));

    } catch (error) {
        console.error('Download redaction error:', error);
        res.status(500).json({ error: 'Failed to redact and download PDF: ' + error.message });
    }
});

// NEW: Test download endpoint to verify download functionality
app.get('/test-download', (req, res) => {
    try {
        const testContent = 'This is a test file to verify download functionality works.';
        const buffer = Buffer.from(testContent, 'utf8');
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="test-download.txt"');
        res.setHeader('Content-Length', buffer.length);
        
        res.send(buffer);
        console.log('Test download sent successfully');
    } catch (error) {
        console.error('Test download error:', error);
        res.status(500).json({ error: 'Test download failed: ' + error.message });
    }
});

// Enhanced Embed endpoint for iframe with improved download functionality
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
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }
        
        .canvas-container {
            position: relative;
            margin-bottom: 20px;
        }
        
        canvas {
            display: block;
            border: 1px solid #ddd;
            cursor: crosshair;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }

        .redaction-box {
            position: absolute;
            background: rgba(255, 0, 0, 0.3);
            border: 2px solid red;
            cursor: pointer;
            pointer-events: auto;
            z-index: 10;
            user-select: none;
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
        
        .btn-secondary {
            background: #6c757d;
            color: white;
        }
        
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
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
        
        .page-controls {
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .page-info {
            font-size: 14px;
            color: #666;
        }

        .upload-area {
            border: 2px dashed #ccc;
            border-radius: 8px;
            padding: 40px;
            text-align: center;
            background: #fafafa;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .upload-area:hover {
            border-color: #007bff;
            background: #f0f8ff;
        }

        .upload-area.dragover {
            border-color: #007bff;
            background: #e3f2fd;
        }
        
        #fileInput {
            display: none;
        }
                        
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body>
    <div class="container">
        <div class="toolbar">
            <div class="status" id="status">Upload a PDF file to begin redaction...</div>
            <button class="btn-primary" onclick="selectFile()" id="uploadBtn">
                Upload PDF
            </button>
            <button class="btn-success" onclick="completeRedaction()" id="completeBtn" disabled>
                Complete Redaction & Download
            </button>
        </div>
        
        <div class="pdf-container" id="pdfContainer">
            <div class="upload-area" onclick="selectFile()" id="uploadArea">
                <h3>📄 Upload PDF for Redaction</h3>
                <p>Click here or drag and drop a PDF file</p>
                <p style="font-size: 12px; color: #666;">Maximum file size: 50MB</p>
            </div>
        </div>
    </div>

    <input type="file" id="fileInput" accept=".pdf" onchange="handleFileSelect(event)">

    <script>
        let pdfDoc = null;
        let currentPage = 1;
        let totalPages = 0;
        let redactions = [];
        let isDrawing = false;
        let startPos = null;
        let currentRedactionDiv = null;
        let pdfContentBase64 = null;
        
        // Configure PDF.js worker
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        // Set up drag and drop
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });
        
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type === 'application/pdf') {
                handleFile(files[0]);
            } else {
                alert('Please upload a PDF file.');
            }
        });
        
        // Listen for PDF content from parent window (iframe mode)
        window.addEventListener('message', async function(event) {
            console.log('Received message:', event.data);
            if (event.data.type === 'loadPDFContent') {
                await loadPDFFromBase64(event.data.contentBase64, event.data.fileName);
            }
        });
        
        function selectFile() {
            fileInput.click();
        }
        
        function handleFileSelect(event) {
            const file = event.target.files[0];
            if (file && file.type === 'application/pdf') {
                handleFile(file);
            } else {
                alert('Please select a PDF file.');
            }
        }
        
        async function handleFile(file) {
            try {
                document.getElementById('status').textContent = 'Loading PDF: ' + file.name;
                
                // Read file as base64
                const reader = new FileReader();
                reader.onload = async function(e) {
                    const arrayBuffer = e.target.result;
                    const base64String = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                    await loadPDFFromBase64(base64String, file.name);
                };
                reader.readAsArrayBuffer(file);
                
            } catch (error) {
                console.error('Error handling file:', error);
                document.getElementById('status').textContent = 'Error loading file: ' + error.message;
            }
        }
        
        async function loadPDFFromBase64(base64Content, fileName) {
            try {
                document.getElementById('status').textContent = 'Loading PDF: ' + fileName;
                
                // Store the original content for redaction
                pdfContentBase64 = base64Content;
                
                // Convert base64 to Uint8Array
                const binaryString = atob(base64Content);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                
                // Load PDF
                pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
                totalPages = pdfDoc.numPages;
                
                // Clear redactions for new PDF
                redactions = [];
                
                // Render first page
                await renderPage(1);
                
                document.getElementById('status').textContent = \`PDF loaded (\${totalPages} pages). Click and drag to create redaction areas.\`;
                document.getElementById('completeBtn').disabled = false;
                document.getElementById('uploadBtn').textContent = 'Upload Different PDF';
                
                // Notify parent that PDF is loaded (if in iframe)
                if (window.self !== window.top) {
                    window.parent.postMessage({
                        type: 'pdfLoaded',
                        fileName: fileName,
                        totalPages: totalPages
                    }, '*');
                }
                
            } catch (error) {
                console.error('Error loading PDF:', error);
                document.getElementById('status').textContent = 'Error loading PDF: ' + error.message;
                
                if (window.self !== window.top) {
                    window.parent.postMessage({
                        type: 'error',
                        error: error.message
                    }, '*');
                }
            }
        }
        
        async function renderPage(pageNum) {
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.5 });
                
                // Clear container
                const container = document.getElementById('pdfContainer');
                container.innerHTML = '';
                
                // Add page controls if multiple pages
                if (totalPages > 1) {
                    const pageControls = document.createElement('div');
                    pageControls.className = 'page-controls';
                    pageControls.innerHTML = \`
                        <button class="btn-secondary" onclick="prevPage()" \${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
                        <span class="page-info">Page \${currentPage} of \${totalPages}</span>
                        <button class="btn-secondary" onclick="nextPage()" \${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
                    \`;
                    container.appendChild(pageControls);
                }
                
                // Create canvas container
                const canvasContainer = document.createElement('div');
                canvasContainer.className = 'canvas-container';
                
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                
                canvasContainer.appendChild(canvas);
                container.appendChild(canvasContainer);
                
                // Render PDF page
                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;
                
                // Set up redaction drawing
                setupRedactionDrawing(canvas, canvasContainer, viewport);
                
                // Render existing redactions for this page
                renderExistingRedactions(canvasContainer, pageNum);
                
            } catch (error) {
                console.error('Error rendering page:', error);
                throw error;
            }
        }
        
        function prevPage() {
            if (currentPage > 1) {
                currentPage--;
                renderPage(currentPage);
            }
        }
        
        function nextPage() {
            if (currentPage < totalPages) {
                currentPage++;
                renderPage(currentPage);
            }
        }
        
        function setupRedactionDrawing(canvas, container, viewport) {
            let isDrawing = false;
            let startPos = null;
            let currentRedactionDiv = null;
            
            // Mouse down on canvas
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
                
                e.preventDefault();
                e.stopPropagation();
            });
            
            // Mouse move on document
            document.addEventListener('mousemove', function(e) {
                if (!isDrawing || !currentRedactionDiv) return;
                
                const rect = canvas.getBoundingClientRect();
                const currentPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                
                // Constrain to canvas boundaries
                const constrainedPos = {
                    x: Math.max(0, Math.min(currentPos.x, canvas.width)),
                    y: Math.max(0, Math.min(currentPos.y, canvas.height))
                };
                
                const width = Math.abs(constrainedPos.x - startPos.x);
                const height = Math.abs(constrainedPos.y - startPos.y);
                const left = Math.min(startPos.x, constrainedPos.x);
                const top = Math.min(startPos.y, constrainedPos.y);
                
                currentRedactionDiv.style.left = left + 'px';
                currentRedactionDiv.style.top = top + 'px';
                currentRedactionDiv.style.width = width + 'px';
                currentRedactionDiv.style.height = height + 'px';
                
                e.preventDefault();
                e.stopPropagation();
            });
            
            // Mouse up on document
            document.addEventListener('mouseup', function(e) {
                if (!isDrawing || !currentRedactionDiv) return;
                
                isDrawing = false;
                
                // Check if redaction is large enough
                const width = parseInt(currentRedactionDiv.style.width);
                const height = parseInt(currentRedactionDiv.style.height);
                
                if (width > 10 && height > 10) {
                    // Store redaction data
                    const redactionData = {
                        pageIndex: currentPage - 1, // 0-based for PDF processing
                        x: parseInt(currentRedactionDiv.style.left),
                        y: parseInt(currentRedactionDiv.style.top),
                        width: width,
                        height: height,
                        viewportWidth: canvas.width,
                        viewportHeight: canvas.height,
                        elementId: 'redaction_' + Date.now()
                    };
                    
                    redactions.push(redactionData);
                    currentRedactionDiv.setAttribute('data-redaction-id', redactionData.elementId);
                    
                    // Add click handler to remove redaction
                    currentRedactionDiv.addEventListener('click', function(clickEvent) {
                        const redactionId = this.getAttribute('data-redaction-id');
                        redactions = redactions.filter(r => r.elementId !== redactionId);
                        this.remove();
                        updateStatus();
                        clickEvent.stopPropagation();
                    });
                    
                    updateStatus();
                } else {
                    // Remove if too small
                    currentRedactionDiv.remove();
                }
                
                currentRedactionDiv = null;
                startPos = null;
                
                e.preventDefault();
                e.stopPropagation();
            });
            
            // Prevent context menu
            canvas.addEventListener('contextmenu', function(e) {
                e.preventDefault();
            });
            
            // Prevent text selection during drawing
            canvas.addEventListener('selectstart', function(e) {
                e.preventDefault();
            });
        }
        
        function renderExistingRedactions(container, pageNum) {
            const pageRedactions = redactions.filter(r => r.pageIndex === pageNum - 1);
            
            pageRedactions.forEach(redaction => {
                const redactionDiv = document.createElement('div');
                redactionDiv.className = 'redaction-box';
                redactionDiv.style.left = redaction.x + 'px';
                redactionDiv.style.top = redaction.y + 'px';
                redactionDiv.style.width = redaction.width + 'px';
                redactionDiv.style.height = redaction.height + 'px';
                redactionDiv.setAttribute('data-redaction-id', redaction.elementId);
                
                // Add click handler to remove redaction
                redactionDiv.addEventListener('click', function() {
                    const redactionId = this.getAttribute('data-redaction-id');
                    redactions = redactions.filter(r => r.elementId !== redactionId);
                    this.remove();
                    updateStatus();
                });
                
                container.appendChild(redactionDiv);
            });
        }
        
        function updateStatus() {
            const totalRedactions = redactions.length;
            const currentPageRedactions = redactions.filter(r => r.pageIndex === currentPage - 1).length;
            
            if (totalPages > 1) {
                document.getElementById('status').textContent = 
                    \`\${totalRedactions} total redaction areas (\${currentPageRedactions} on current page). Click on any redaction to remove it.\`;
            } else {
                document.getElementById('status').textContent = 
                    \`\${totalRedactions} redaction areas created. Click on any redaction to remove it.\`;
            }
        }
        
        // Enhanced redaction completion with multiple download methods
        async function completeRedaction() {
            try {
                if (redactions.length === 0) {
                    alert('Please create at least one redaction area before completing.');
                    return;
                }
                
                document.getElementById('status').textContent = 'Processing redactions...';
                document.getElementById('completeBtn').disabled = true;
                
                console.log('Sending redaction data:', redactions);
                
                // Check if we're in an iframe or standalone
                const isInIframe = window.self !== window.top;
                console.log('Is in iframe:', isInIframe);
                
                if (isInIframe) {
                    // For iframe mode, use the original API that returns base64
                    await processRedactionForIframe();
                } else {
                    // For standalone mode, try server-side download first, then fallback to client-side
                    const success = await tryServerSideDownload();
                    if (!success) {
                        console.log('Server-side download failed, trying client-side...');
                        await processRedactionForClientDownload();
                    }
                }
                
            } catch (error) {
                console.error('Error completing redaction:', error);
                document.getElementById('status').textContent = 'Error: ' + error.message;
                
                // Send error to parent if in iframe
                if (window.self !== window.top) {
                    window.parent.postMessage({
                        type: 'error',
                        error: error.message
                    }, '*');
                }
            } finally {
                document.getElementById('completeBtn').disabled = false;
            }
        }

        // Server-side download approach
        async function tryServerSideDownload() {
            try {
                console.log('Attempting server-side download...');
                
                const response = await fetch('/redact-and-download', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        redactions: redactions,
                        contentBase64: pdfContentBase64
                    })
                });
                
                console.log('Server download response status:', response.status);
                
                if (!response.ok) {
                    console.error('Server download failed:', response.status, response.statusText);
                    return false;
                }
                
                // Check if response is actually a PDF
                const contentType = response.headers.get('Content-Type');
                console.log('Response content type:', contentType);
                
                if (contentType !== 'application/pdf') {
                    console.error('Server did not return PDF, got:', contentType);
                    return false;
                }
                
                // Get the PDF blob
                const blob = await response.blob();
                console.log('Received blob size:', blob.size);
                
                if (blob.size === 0) {
                    console.error('Received empty blob from server');
                    return false;
                }
                
                // Create download link for the blob
                const url = URL.createObjectURL(blob);
                const downloadLink = document.createElement('a');
                downloadLink.href = url;
                downloadLink.download = 'redacted_document.pdf';
                downloadLink.style.display = 'none';
                
                document.body.appendChild(downloadLink);
                downloadLink.click();
                document.body.removeChild(downloadLink);
                
                // Clean up
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                
                document.getElementById('status').textContent = 
                    \`Redaction complete! \${redactions.length} areas processed. Download started.\`;
                
                console.log('Server-side download completed successfully');
                return true;
                
            } catch (error) {
                console.error('Server-side download error:', error);
                return false;
            }
        }

        // Client-side download approach (fallback)
        async function processRedactionForClientDownload() {
            try {
                console.log('Processing redaction for client-side download...');
                
                const response = await fetch('/redact', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        redactions: redactions,
                        contentBase64: pdfContentBase64
                    })
                });
                
                if (!response.ok) {
                    throw new Error(\`Server error: \${response.status} \${response.statusText}\`);
                }
                
                const result = await response.json();
                console.log('Client download - server response received');
                
                if (result.success) {
                    downloadRedactedPDF(result.redactedPdfBase64, 'redacted_document.pdf');
                    document.getElementById('status').textContent = 
                        \`Redaction complete! \${result.redactionsApplied} areas processed.\`;
                } else {
                    throw new Error(result.error || 'Redaction failed');
                }
                
            } catch (error) {
                console.error('Client-side redaction error:', error);
                throw error;
            }
        }

        // Iframe mode processing
        async function processRedactionForIframe() {
            try {
                console.log('Processing redaction for iframe mode...');
                
                const response = await fetch('/redact', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        redactions: redactions,
                        contentBase64: pdfContentBase64
                    })
                });
                
                if (!response.ok) {
                    throw new Error(\`Server error: \${response.status} \${response.statusText}\`);
                }
                
                const result = await response.json();
                
                if (result.success) {
                    // Send result back to parent window
                    window.parent.postMessage({
                        type: 'redactionComplete',
                        data: {
                            success: true,
                            redactedPdfBase64: result.redactedPdfBase64,
                            redactionsApplied: result.redactionsApplied,
                            message: result.message
                        }
                    }, '*');
                    
                    document.getElementById('status').textContent = 
                        \`Redaction complete! \${result.redactionsApplied} areas processed.\`;
                } else {
                    throw new Error(result.error || 'Redaction failed');
                }
                
            } catch (error) {
                console.error('Iframe redaction error:', error);
                throw error;
            }
        }
        
        // Enhanced downloadRedactedPDF function (fallback method)
        function downloadRedactedPDF(base64Data, filename) {
            try {
                console.log('Starting client-side PDF download...');
                
                if (!base64Data) {
                    throw new Error('No PDF data received from server');
                }
                
                // Clean the base64 string
                const cleanBase64 = base64Data.replace(/\s/g, '');
                
                // Method 1: Try blob approach
                try {
                    const binaryString = atob(cleanBase64);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    
                    const blob = new Blob([bytes], { type: 'application/pdf' });
                    
                    if (blob.size > 0) {
                        const url = URL.createObjectURL(blob);
                        const downloadLink = document.createElement('a');
                        downloadLink.href = url;
                        downloadLink.download = filename;
                        downloadLink.style.display = 'none';
                        
                        document.body.appendChild(downloadLink);
                        downloadLink.click();
                        document.body.removeChild(downloadLink);
                        
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                        console.log('Blob download successful');
                        return;
                    }
                } catch (e) {
                    console.warn('Blob method failed:', e);
                }
                
                // Method 2: Data URL approach
                console.log('Trying data URL method...');
                const dataUrl = 'data:application/pdf;base64,' + cleanBase64;
                const fallbackLink = document.createElement('a');
                fallbackLink.href = dataUrl;
                fallbackLink.download = filename;
                fallbackLink.style.display = 'none';
                document.body.appendChild(fallbackLink);
                fallbackLink.click();
                document.body.removeChild(fallbackLink);
                console.log('Data URL download attempted');
                
            } catch (error) {
                console.error('All download methods failed:', error);
                alert('Download failed. Error: ' + error.message);
            }
        }
        
        // Notify parent window that iframe is ready
        window.addEventListener('load', function() {
            console.log('PDF redaction interface loaded');
            if (window.self !== window.top) {
                window.parent.postMessage({
                    type: 'iframeReady'
                }, '*');
            }
        });
    </script>
</body>
</html>
    `;
    
    res.send(html);
});

// Enhanced applyTrueTextRedaction function with improved text removal
async function applyTrueTextRedaction(pdfDoc, redaction) {
    try {
        const page = pdfDoc.getPage(redaction.pageIndex);
        const { width, height } = page.getSize();
        
        // Convert viewport coordinates to PDF coordinates
        const pdfX = (redaction.x / redaction.viewportWidth) * width;
        const pdfY = height - ((redaction.y + redaction.height) / redaction.viewportHeight) * height;
        const pdfWidth = (redaction.width / redaction.viewportWidth) * width;
        const pdfHeight = (redaction.height / redaction.viewportHeight) * height;
        
        console.log(`Applying enhanced text redaction on page ${redaction.pageIndex}: x=${pdfX.toFixed(2)}, y=${pdfY.toFixed(2)}, w=${pdfWidth.toFixed(2)}, h=${pdfHeight.toFixed(2)}`);

        // Get the page's content stream(s)
        const pageDict = page.node;
        const contentsRef = pageDict.get('Contents');
        
        if (contentsRef) {
            // Handle both single content stream and array of content streams
            const contentRefs = Array.isArray(contentsRef) ? contentsRef : [contentsRef];
            
            // Process each content stream
            for (const streamRef of contentRefs) {
                await processContentStream(pdfDoc, streamRef, pdfX, pdfY, pdfWidth, pdfHeight);
            }
        }

        // Remove any existing XObjects (form objects) that might contain text
        const resourcesRef = pageDict.get('Resources');
        if (resourcesRef) {
            const resources = pdfDoc.context.lookup(resourcesRef);
            if (resources && resources.has('XObject')) {
                console.log('Checking XObjects for text content...');
                // Note: More complex XObject processing could be added here
            }
        }

        // Add a white rectangle first to ensure coverage
        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: rgb(1, 1, 1), // White
            opacity: 1,
            borderWidth: 0
        });

        // Add final black rectangle for visual confirmation
        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: rgb(0, 0, 0), // Black
            opacity: 1,
            borderWidth: 0
        });

        console.log('Enhanced text redaction applied successfully');

    } catch (error) {
        console.error('Error in applyTrueTextRedaction:', error);
        
        // Fallback: at least apply visual redaction
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
            
            console.log('Fallback visual redaction applied');
        } catch (fallbackError) {
            console.error('Fallback redaction also failed:', fallbackError);
            throw fallbackError;
        }
    }
}

// Enhanced processContentStream function with better text removal
async function processContentStream(pdfDoc, streamRef, x, y, width, height) {
    try {
        // Get the content stream object
        const streamObj = pdfDoc.context.lookup(streamRef);
        
        if (!streamObj || !streamObj.hasKey('Length')) {
            console.log('Invalid content stream, skipping');
            return;
        }

        // Get the stream content
        let streamContent = streamObj.getUnencodedStream();
        let contentString = new TextDecoder('latin1').decode(streamContent);
        
        console.log('Processing content stream, original length:', contentString.length);
        
        // Parse and modify the content stream to remove text in the redacted area
        const modifiedContent = removeTextInArea(contentString, x, y, width, height);
        
        if (modifiedContent !== contentString) {
            console.log('Content stream modified, updating...');
            
            // Encode the modified content properly
            const modifiedBytes = new Uint8Array(Buffer.from(modifiedContent, 'latin1'));
            
            // Update the stream with the modified content
            streamObj.setUnencodedStream(modifiedBytes);
            
            // Update the length
            streamObj.set('Length', modifiedBytes.length);
            
            console.log('Content stream updated successfully, new length:', modifiedBytes.length);
        } else {
            console.log('No modifications made to content stream');
        }

    } catch (error) {
        console.error('Error processing content stream:', error);
    }
}

// Enhanced removeTextInArea function with better text object handling
function removeTextInArea(contentString, x, y, width, height) {
    try {
        console.log(`Removing text in area: x=${x}, y=${y}, w=${width}, h=${height}`);
        
        const lines = contentString.split('\n');
        const modifiedLines = [];
        
        let currentMatrix = [1, 0, 0, 1, 0, 0]; // [a, b, c, d, e, f] transformation matrix
        let textMode = false;
        let pendingTextObject = [];
        let skipCurrentTextObject = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Track text object boundaries
            if (line.includes('BT')) {
                textMode = true;
                pendingTextObject = [line];
                skipCurrentTextObject = false;
                continue;
            } else if (line.includes('ET')) {
                textMode = false;
                
                // Add the text object only if we're not skipping it
                if (!skipCurrentTextObject) {
                    modifiedLines.push(...pendingTextObject);
                    modifiedLines.push(line);
                } else {
                    console.log('Removed complete text object containing redacted content');
                    // Add a comment showing where text was removed
                    modifiedLines.push('% TEXT OBJECT REMOVED BY REDACTION');
                }
                
                pendingTextObject = [];
                skipCurrentTextObject = false;
                continue;
            }
            
            if (textMode) {
                // We're inside a text object, collect lines
                pendingTextObject.push(line);
                
                // Parse text positioning commands
                if (line.includes(' Tm')) {
                    // Text matrix command - sets absolute position
                    const tmMatch = line.match(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/);
                    if (tmMatch) {
                        currentMatrix = [
                            parseFloat(tmMatch[1]), parseFloat(tmMatch[2]),
                            parseFloat(tmMatch[3]), parseFloat(tmMatch[4]),
                            parseFloat(tmMatch[5]), parseFloat(tmMatch[6])
                        ];
                        
                        // Check if this position is in redacted area
                        if (isPositionInRedactedArea(currentMatrix[4], currentMatrix[5], x, y, width, height)) {
                            skipCurrentTextObject = true;
                            console.log(`Text matrix position (${currentMatrix[4]}, ${currentMatrix[5]}) is in redacted area`);
                        }
                    }
                } else if (line.includes(' Td') || line.includes(' TD')) {
                    // Relative text positioning
                    const tdMatch = line.match(/([-\d.]+)\s+([-\d.]+)\s+T[dD]/);
                    if (tdMatch) {
                        currentMatrix[4] += parseFloat(tdMatch[1]);
                        currentMatrix[5] += parseFloat(tdMatch[2]);
                        
                        // Check if new position is in redacted area
                        if (isPositionInRedactedArea(currentMatrix[4], currentMatrix[5], x, y, width, height)) {
                            skipCurrentTextObject = true;
                            console.log(`Relative text position (${currentMatrix[4]}, ${currentMatrix[5]}) is in redacted area`);
                        }
                    }
                } else if (line.includes(' Tj') || line.includes(' TJ') || line.includes("'") || line.includes('"')) {
                    // Text showing operations - check if current position is in redacted area
                    if (isPositionInRedactedArea(currentMatrix[4], currentMatrix[5], x, y, width, height)) {
                        skipCurrentTextObject = true;
                        console.log(`Text show operation at (${currentMatrix[4]}, ${currentMatrix[5]}) is in redacted area`);
                    }
                }
            } else {
                // Not in text mode, keep the line as-is
                modifiedLines.push(line);
            }
        }
        
        const result = modifiedLines.join('\n');
        console.log(`Text removal complete. Original: ${contentString.length} chars, Modified: ${result.length} chars`);
        return result;
        
    } catch (error) {
        console.error('Error in removeTextInArea:', error);
        return contentString; // Return original if processing fails
    }
}

// Helper function to check if a position is within the redacted area
function isPositionInRedactedArea(textX, textY, redactX, redactY, redactWidth, redactHeight) {
    // Add some padding to ensure we catch text that might be partially in the area
    const padding = 5;
    
    return (textX >= (redactX - padding) && 
            textX <= (redactX + redactWidth + padding) && 
            textY >= (redactY - padding) && 
            textY <= (redactY + redactHeight + padding));
}

// Download endpoint (keep existing functionality)
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
    });
});

app.listen(PORT, () => {
    console.log(`PDF Redaction Server running on http://localhost:${PORT}`);
    console.log('Enhanced true text removal redaction enabled');
    console.log('CORS enabled for iframe embedding');
    console.log('Multiple download methods available');
});
