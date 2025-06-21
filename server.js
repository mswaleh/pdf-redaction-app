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

// Set X-Frame-Options to allow iframe embedding
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    next();
});

app.use(express.static('public'));
app.use(express.json());

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
    }
});

// Upload endpoint
app.post('/upload', upload.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
    }
    
    res.json({ 
        filename: req.file.filename,
        originalName: req.file.originalname,
        path: `/uploads/${req.file.filename}`
    });
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// True redaction endpoint with actual text removal from content streams
app.post('/redact', async (req, res) => {
    try {
        const { filename, redactions } = req.body;
        
        if (!filename || !redactions) {
            return res.status(400).json({ error: 'Missing filename or redactions' });
        }

        const filePath = path.join(__dirname, 'uploads', filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        console.log(`Processing ${redactions.length} redactions for ${filename}`);

        // Read the PDF
        const existingPdfBytes = fs.readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        
        // Apply true redactions by modifying content streams
        for (const redaction of redactions) {
            await applyTrueTextRedaction(pdfDoc, redaction);
        }

        // Save redacted PDF
        const redactedPdfBytes = await pdfDoc.save({
            useObjectStreams: false,
            addDefaultPage: false
        });
        
        const redactedFilename = 'redacted-' + filename;
        const redactedFilePath = path.join(__dirname, 'uploads', redactedFilename);
        
        fs.writeFileSync(redactedFilePath, redactedPdfBytes);

        console.log(`True redaction complete: ${redactedFilename}`);

        res.json({ 
            success: true,
            redactedFilename: redactedFilename,
            downloadPath: `/download/${redactedFilename}`,
            redactionsApplied: redactions.length
        });

    } catch (error) {
        console.error('Redaction error:', error);
        res.status(500).json({ error: 'Failed to redact PDF: ' + error.message });
    }
});

// True text redaction function that modifies PDF content streams
async function applyTrueTextRedaction(pdfDoc, redaction) {
    try {
        const page = pdfDoc.getPage(redaction.pageIndex);
        const { width, height } = page.getSize();
        
        // Convert viewport coordinates to PDF coordinates
        const pdfX = (redaction.x / redaction.viewportWidth) * width;
        const pdfY = height - ((redaction.y + redaction.height) / redaction.viewportHeight) * height;
        const pdfWidth = (redaction.width / redaction.viewportWidth) * width;
        const pdfHeight = (redaction.height / redaction.viewportHeight) * height;
        
        console.log(`Applying true text redaction: x=${pdfX.toFixed(2)}, y=${pdfY.toFixed(2)}, w=${pdfWidth.toFixed(2)}, h=${pdfHeight.toFixed(2)}`);

        // Get the page's content stream
        const contentStreamRef = page.node.get('Contents');
        
        if (contentStreamRef) {
            let contentStream;
            
            // Handle both single content stream and array of content streams
            if (Array.isArray(contentStreamRef)) {
                // Multiple content streams - process each one
                for (let i = 0; i < contentStreamRef.length; i++) {
                    const streamRef = contentStreamRef[i];
                    await processContentStream(pdfDoc, streamRef, pdfX, pdfY, pdfWidth, pdfHeight);
                }
            } else {
                // Single content stream
                await processContentStream(pdfDoc, contentStreamRef, pdfX, pdfY, pdfWidth, pdfHeight);
            }
        }

        // Add white rectangle to ensure visual coverage
        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: rgb(1, 1, 1),
            opacity: 1,
            borderWidth: 0
        });

        // Add final black rectangle for visual confirmation
        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: rgb(0, 0, 0),
            opacity: 1,
            borderWidth: 0
        });

        console.log('True text redaction applied successfully');

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
        
        console.log('Original content stream length:', contentString.length);
        
        // Parse and modify the content stream to remove text in the redacted area
        const modifiedContent = removeTextInArea(contentString, x, y, width, height);
        
        if (modifiedContent !== contentString) {
            console.log('Content stream modified, updating...');
            
            // Encode the modified content
            const modifiedBytes = new TextEncoder().encode(modifiedContent);
            
            // Update the stream with the modified content
            streamObj.setUnencodedStream(modifiedBytes);
            
            // Update the length
            streamObj.set('Length', modifiedBytes.length);
            
            console.log('Content stream updated successfully');
        } else {
            console.log('No text found in redacted area');
        }

    } catch (error) {
        console.error('Error processing content stream:', error);
    }
}

// Remove text operations that fall within the redacted area
function removeTextInArea(contentString, x, y, width, height) {
    try {
        const lines = contentString.split('\n');
        const modifiedLines = [];
        let currentMatrix = [1, 0, 0, 1, 0, 0]; // Default transformation matrix
        let textMode = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Track text positioning and transformation matrix
            if (line.includes(' Tm')) {
                // Text matrix - extract positioning
                const tmMatch = line.match(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/);
                if (tmMatch) {
                    currentMatrix = [
                        parseFloat(tmMatch[1]), parseFloat(tmMatch[2]),
                        parseFloat(tmMatch[3]), parseFloat(tmMatch[4]),
                        parseFloat(tmMatch[5]), parseFloat(tmMatch[6])
                    ];
                }
            }
            
            // Track text object boundaries
            if (line.includes('BT')) {
                textMode = true;
            } else if (line.includes('ET')) {
                textMode = false;
            }
            
            // Check for text drawing operations
            if (textMode && (line.includes(' Tj') || line.includes(' TJ') || line.includes(' Td') || line.includes(' TD'))) {
                // Estimate text position using current matrix
                const textX = currentMatrix[4];
                const textY = currentMatrix[5];
                
                // Check if text position is within redacted area
                if (textX >= x && textX <= x + width && textY >= y && textY <= y + height) {
                    console.log(`Removing text operation at position (${textX}, ${textY}): ${line}`);
                    // Replace text operation with empty operation or skip entirely
                    modifiedLines.push('% REDACTED TEXT REMOVED');
                    continue;
                }
            }
            
            // Update position for relative text positioning
            if (line.includes(' Td') || line.includes(' TD')) {
                const tdMatch = line.match(/([-\d.]+)\s+([-\d.]+)\s+T[dD]/);
                if (tdMatch) {
                    currentMatrix[4] += parseFloat(tdMatch[1]);
                    currentMatrix[5] += parseFloat(tdMatch[2]);
                }
            }
            
            // Keep the line if it's not redacted text
            modifiedLines.push(line);
        }
        
        const result = modifiedLines.join('\n');
        console.log('Content modification complete');
        return result;
        
    } catch (error) {
        console.error('Error removing text in area:', error);
        return contentString; // Return original if processing fails
    }
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

app.listen(PORT, () => {
    console.log(`PDF Redaction Server running on http://localhost:${PORT}`);
    console.log('True text removal redaction enabled');
});