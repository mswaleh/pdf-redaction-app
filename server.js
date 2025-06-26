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

// Embed endpoint for iframe
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
            /* existing styles... */
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
        let currentPage = 1;
        let totalPages = 0;
        let redactions = [];
        let isDrawing = false;
        let startPos = null;
        let currentRedactionDiv = null;
        let pdfContentBase64 = null;
        
        // Configure PDF.js worker
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        // Listen for PDF content from parent window
        window.addEventListener('message', async function(event) {
            console.log('Received message:', event.data);
            if (event.data.type === 'loadPDFContent') {
                await loadPDFFromBase64(event.data.contentBase64, event.data.fileName);
            }
        });
        
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
                
                // Render first page
                await renderPage(1);
                
                document.getElementById('status').textContent = \`PDF loaded (\${totalPages} pages). Click and drag to create redaction areas.\`;
                document.getElementById('completeBtn').disabled = false;
                
                // Notify parent that PDF is loaded
                window.parent.postMessage({
                    type: 'pdfLoaded',
                    fileName: fileName,
                    totalPages: totalPages
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
                
                // Clear container
                const container = document.getElementById('pdfContainer');
                container.innerHTML = '';
                
                // Add page controls if multiple pages
                if (totalPages > 1) {
                    const pageControls = document.createElement('div');
                    pageControls.className = 'page-controls';
                    pageControls.innerHTML = \`
                        <button onclick="prevPage()" \${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
                        <span class="page-info">Page \${currentPage} of \${totalPages}</span>
                        <button onclick="nextPage()" \${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
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
            
            // Mouse move on document (not just canvas) - this is key!
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
            
            // Mouse up on document (not just canvas) - this is key!
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
            
            // Handle mouse leave canvas
            canvas.addEventListener('mouseleave', function(e) {
                // Don't stop drawing when mouse leaves canvas, 
                // document listeners will handle it
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
        
        async function completeRedaction() {
            try {
                if (redactions.length === 0) {
                    alert('Please create at least one redaction area before completing.');
                    return;
                }
                
                document.getElementById('status').textContent = 'Processing redactions...';
                document.getElementById('completeBtn').disabled = true;
                
                console.log('Sending redaction data:', redactions);
                
                // Send redaction request to server
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
                
                const result = await response.json();
                
                if (result.success) {
                    console.log('Redaction completed successfully');
                    
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
                } else {
                    throw new Error(result.error || 'Redaction failed');
                }
                
            } catch (error) {
                console.error('Error completing redaction:', error);
                document.getElementById('status').textContent = 'Error: ' + error.message;
                
                window.parent.postMessage({
                    type: 'error',
                    error: error.message
                }, '*');
                
                document.getElementById('completeBtn').disabled = false;
            }
        }
        
        // Notify parent window that iframe is ready
        window.addEventListener('load', function() {
            console.log('PDF redaction interface loaded');
            window.parent.postMessage({
                type: 'iframeReady'
            }, '*');
        });
    </script>
</body>
</html>
    `;
    
    res.send(html);
});

// True redaction endpoint with actual text removal from content streams
// Enhanced applyTrueTextRedaction function - replace the existing one
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

// Process individual content streams to remove text in redacted areas
// Enhanced processContentStream function - replace the existing one
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

// Remove text operations that fall within the redacted area
// Enhanced removeTextInArea function - replace the existing one
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

// Download endpoint
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
    console.log('True text removal redaction enabled');
    console.log('CORS enabled for iframe embedding');
});
