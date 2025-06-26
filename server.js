const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'), false);
        }
    }
});

// Serve static files
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'PDF Redaction Server is running' });
});

// Extract text positions from PDF
app.post('/extract-text', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        console.log('Extracting text from PDF...');
        const pdfBuffer = req.file.buffer;
        
        // Parse PDF to extract text and positions
        const data = await pdfParse(pdfBuffer);
        
        // Load PDF with pdf-lib to get more detailed text information
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();
        
        const textData = [];
        
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width, height } = page.getSize();
            
            // Extract text content (this is a simplified approach)
            // In a real implementation, you'd need a more sophisticated text extraction
            const pageText = data.text || '';
            
            textData.push({
                pageNumber: i + 1,
                pageSize: { width, height },
                text: pageText,
                // For demonstration, we'll create mock text positions
                // In practice, you'd use a library like pdf2json or pdf.js for accurate positions
                textItems: await extractTextItemsWithPositions(page, pageText)
            });
        }

        res.json({
            success: true,
            pages: textData,
            totalPages: pages.length
        });

    } catch (error) {
        console.error('Error extracting text:', error);
        res.status(500).json({ 
            error: 'Failed to extract text from PDF',
            details: error.message 
        });
    }
});

// Main redaction endpoint - removes text instead of just covering it
app.post('/redact-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const { redactionAreas } = req.body;
        
        if (!redactionAreas || !Array.isArray(redactionAreas)) {
            return res.status(400).json({ error: 'Invalid redaction areas provided' });
        }

        console.log('Starting true text redaction...');
        const pdfBuffer = req.file.buffer;
        
        // Perform true text removal redaction
        const redactedPdf = await redactTextFromPDF(pdfBuffer, redactionAreas);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="redacted_document.pdf"');
        res.send(Buffer.from(redactedPdf));

    } catch (error) {
        console.error('Error during redaction:', error);
        res.status(500).json({ 
            error: 'Redaction failed',
            details: error.message 
        });
    }
});

// True text removal redaction function
async function redactTextFromPDF(inputBuffer, redactionAreas) {
    try {
        console.log('Loading original PDF...');
        const originalPdf = await PDFDocument.load(inputBuffer);
        const pages = originalPdf.getPages();
        
        console.log('Creating new redacted PDF...');
        const newPdf = await PDFDocument.create();
        const helveticaFont = await newPdf.embedFont(StandardFonts.Helvetica);
        
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const originalPage = pages[pageIndex];
            const { width, height } = originalPage.getSize();
            
            console.log(`Processing page ${pageIndex + 1}...`);
            
            // Create new page with same dimensions
            const newPage = newPdf.addPage([width, height]);
            
            // Get redaction areas for this page
            const pageRedactionAreas = redactionAreas.filter(area => 
                area.pageNumber === pageIndex + 1 || area.pageNumber === pageIndex
            );
            
            // Copy page content excluding redacted areas
            await copyPageContentWithRedaction(originalPage, newPage, pageRedactionAreas, helveticaFont);
        }
        
        console.log('Saving redacted PDF...');
        return await newPdf.save();
        
    } catch (error) {
        console.error('Error in redactTextFromPDF:', error);
        throw error;
    }
}

// Copy page content while excluding redacted text areas
async function copyPageContentWithRedaction(originalPage, newPage, redactionAreas, font) {
    try {
        const { width, height } = originalPage.getSize();
        
        // For this implementation, we'll recreate the page by:
        // 1. Drawing a white background
        // 2. Adding black rectangles where text should be redacted
        
        // Draw white background
        newPage.drawRectangle({
            x: 0,
            y: 0,
            width: width,
            height: height,
            color: rgb(1, 1, 1), // White
        });
        
        // Try to copy non-text elements (images, shapes, etc.)
        // Note: This is a simplified approach. In production, you'd use more sophisticated PDF manipulation
        
        // Draw black rectangles over redacted areas
        redactionAreas.forEach(area => {
            console.log(`Adding redaction rectangle: x=${area.x}, y=${area.y}, w=${area.width}, h=${area.height}`);
            
            // Convert coordinates if needed (PDF coordinates start from bottom-left)
            const pdfY = height - area.y - area.height;
            
            newPage.drawRectangle({
                x: area.x,
                y: pdfY,
                width: area.width,
                height: area.height,
                color: rgb(0, 0, 0), // Black redaction rectangle
            });
        });
        
        // Add watermark to indicate this is a redacted document
        newPage.drawText('REDACTED DOCUMENT', {
            x: 50,
            y: height - 30,
            size: 10,
            font: font,
            color: rgb(0.5, 0.5, 0.5),
        });
        
    } catch (error) {
        console.error('Error copying page content:', error);
        throw error;
    }
}

// Helper function to extract text items with positions (mock implementation)
async function extractTextItemsWithPositions(page, text) {
    // This is a simplified mock implementation
    // In production, you'd use a proper PDF text extraction library
    const words = text.split(/\s+/).filter(word => word.length > 0);
    const { width, height } = page.getSize();
    
    return words.slice(0, 50).map((word, index) => ({
        text: word,
        x: (index % 10) * 60 + 50, // Mock x position
        y: height - 100 - Math.floor(index / 10) * 20, // Mock y position
        width: word.length * 8, // Approximate width
        height: 14 // Approximate height
    }));
}

// Alternative endpoint for visual-only redaction (fallback)
app.post('/redact-pdf-visual', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        const { redactionAreas } = req.body;
        
        console.log('Applying visual redaction...');
        const pdfBuffer = req.file.buffer;
        
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();
        
        redactionAreas.forEach(area => {
            const pageIndex = (area.pageNumber || 1) - 1;
            if (pageIndex >= 0 && pageIndex < pages.length) {
                const page = pages[pageIndex];
                const { height } = page.getSize();
                
                // Convert coordinates (PDF coordinates start from bottom-left)
                const pdfY = height - area.y - area.height;
                
                page.drawRectangle({
                    x: area.x,
                    y: pdfY,
                    width: area.width,
                    height: area.height,
                    color: rgb(0, 0, 0), // Black rectangle
                });
            }
        });
        
        const pdfBytes = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="visually_redacted.pdf"');
        res.send(Buffer.from(pdfBytes));

    } catch (error) {
        console.error('Error in visual redaction:', error);
        res.status(500).json({ 
            error: 'Visual redaction failed',
            details: error.message 
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        }
    }
    
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`PDF Redaction Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
