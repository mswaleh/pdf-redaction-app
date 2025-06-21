class PDFRedactionApp {
    constructor() {
        this.pdfDoc = null;
        this.currentPage = 1;
        this.totalPages = 0;
        this.canvas = document.getElementById('pdfCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.redactionLayer = document.getElementById('redactionLayer');
        this.redactions = [];
        this.isRedacting = false;
        this.currentFilename = null;
        this.scale = 1.5;
        
        this.initializeEventListeners();
        this.initializePDFWorker();
    }

    initializePDFWorker() {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    }

    initializeEventListeners() {
        // File upload
        document.getElementById('uploadBtn').addEventListener('click', () => this.uploadPDF());
        document.getElementById('pdfInput').addEventListener('change', (e) => {
            if (e.target.files[0]) {
                document.getElementById('uploadBtn').textContent = 'Upload PDF';
            }
        });

        // Tools
        document.getElementById('redactBtn').addEventListener('click', () => this.toggleRedactionMode());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearRedactions());
        document.getElementById('saveBtn').addEventListener('click', () => this.savePDF());

        // Page navigation
        document.getElementById('prevPage').addEventListener('click', () => this.previousPage());
        document.getElementById('nextPage').addEventListener('click', () => this.nextPage());

        // Redaction drawing - ensure proper event binding
        this.setupRedactionEvents();
    }

    setupRedactionEvents() {
        console.log('Setting up redaction events...');
        
        // Remove existing listeners to avoid duplicates
        this.canvas.removeEventListener('mousedown', this.boundStartRedaction);
        this.canvas.removeEventListener('mousemove', this.boundDrawRedaction);
        this.canvas.removeEventListener('mouseup', this.boundEndRedaction);
        this.canvas.removeEventListener('mouseleave', this.boundEndRedaction);

        // Bind methods to preserve 'this' context
        this.boundStartRedaction = (e) => this.startRedaction(e);
        this.boundDrawRedaction = (e) => this.drawRedaction(e);
        this.boundEndRedaction = () => this.endRedaction();

        // Add event listeners
        this.canvas.addEventListener('mousedown', this.boundStartRedaction);
        this.canvas.addEventListener('mousemove', this.boundDrawRedaction);
        this.canvas.addEventListener('mouseup', this.boundEndRedaction);
        this.canvas.addEventListener('mouseleave', this.boundEndRedaction);
        
        // Test event listener
        this.canvas.addEventListener('click', (e) => {
            console.log('Canvas clicked at:', { x: e.clientX, y: e.clientY });
        });
        
        console.log('Event listeners added to canvas');
        console.log('Canvas dimensions:', { width: this.canvas.width, height: this.canvas.height });
        console.log('Canvas position:', this.canvas.getBoundingClientRect());
    }

    async uploadPDF() {
        const fileInput = document.getElementById('pdfInput');
        const file = fileInput.files[0];

        if (!file) {
            this.showStatus('Please select a PDF file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('pdf', file);

        try {
            this.showStatus('Uploading PDF...', 'info');
            
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                this.currentFilename = result.filename;
                await this.loadPDF(result.path);
                this.showStatus('PDF uploaded successfully!', 'success');
                document.getElementById('toolsSection').style.display = 'block';
                document.getElementById('viewerSection').style.display = 'block';
            } else {
                this.showStatus(result.error || 'Upload failed', 'error');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showStatus('Upload failed. Please try again.', 'error');
        }
    }

    async loadPDF(path) {
        try {
            const loadingTask = pdfjsLib.getDocument(path);
            this.pdfDoc = await loadingTask.promise;
            this.totalPages = this.pdfDoc.numPages;
            this.currentPage = 1;
            this.redactions = [];
            
            await this.renderPage();
            this.updatePageInfo();
            
            // Ensure redaction events are properly bound
            this.setupRedactionEvents();
            
            // Auto-activate redaction mode
            const redactBtn = document.getElementById('redactBtn');
            redactBtn.classList.add('active');
            redactBtn.textContent = 'Redaction Tool (Active)';
            this.canvas.style.cursor = 'crosshair';
            
            console.log('PDF loaded successfully, redaction mode activated'); // Debug log
        } catch (error) {
            console.error('Error loading PDF:', error);
            this.showStatus('Error loading PDF', 'error');
        }
    }

    async renderPage() {
        if (!this.pdfDoc) return;

        const page = await this.pdfDoc.getPage(this.currentPage);
        const viewport = page.getViewport({ scale: this.scale });

        console.log('Rendering page with viewport:', viewport);

        this.canvas.width = viewport.width;
        this.canvas.height = viewport.height;
        
        // Ensure redaction layer matches canvas exactly
        this.redactionLayer.style.width = viewport.width + 'px';
        this.redactionLayer.style.height = viewport.height + 'px';
        this.redactionLayer.style.position = 'absolute';
        this.redactionLayer.style.top = '0px';
        this.redactionLayer.style.left = '0px';

        console.log('Canvas size:', { width: this.canvas.width, height: this.canvas.height });
        console.log('Redaction layer size:', { 
            width: this.redactionLayer.style.width, 
            height: this.redactionLayer.style.height 
        });

        const renderContext = {
            canvasContext: this.ctx,
            viewport: viewport
        };

        await page.render(renderContext).promise;
        this.renderRedactions();
        
        // Re-setup events after page render
        setTimeout(() => {
            this.setupRedactionEvents();
        }, 100);
    }

    renderRedactions() {
        this.redactionLayer.innerHTML = '';
        
        const currentPageRedactions = this.redactions.filter(r => r.pageIndex === this.currentPage - 1);
        
        currentPageRedactions.forEach((redaction, index) => {
            const box = document.createElement('div');
            box.className = 'redaction-box';
            box.style.left = redaction.x + 'px';
            box.style.top = redaction.y + 'px';
            box.style.width = redaction.width + 'px';
            box.style.height = redaction.height + 'px';
            
            box.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeRedaction(redaction);
            });
            
            this.redactionLayer.appendChild(box);
        });
    }

    startRedaction(e) {
        console.log('=== MOUSE DOWN EVENT ===');
        
        // Auto-activate redaction mode if not active
        const redactBtn = document.getElementById('redactBtn');
        if (!redactBtn.classList.contains('active')) {
            redactBtn.classList.add('active');
            redactBtn.textContent = 'Redaction Tool (Active)';
            this.canvas.style.cursor = 'crosshair';
        }
        
        e.preventDefault();
        e.stopPropagation();
        
        this.isRedacting = true;
        const rect = this.canvas.getBoundingClientRect();
        this.redactionStart = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        
        console.log('Canvas rect:', rect);
        console.log('Mouse position:', { clientX: e.clientX, clientY: e.clientY });
        console.log('Starting redaction at:', this.redactionStart);
        
        // Create redaction box
        this.currentRedactionBox = document.createElement('div');
        this.currentRedactionBox.className = 'redaction-box';
        this.currentRedactionBox.style.position = 'absolute';
        this.currentRedactionBox.style.left = this.redactionStart.x + 'px';
        this.currentRedactionBox.style.top = this.redactionStart.y + 'px';
        this.currentRedactionBox.style.width = '1px';
        this.currentRedactionBox.style.height = '1px';
        this.currentRedactionBox.style.zIndex = '10';
        this.currentRedactionBox.style.pointerEvents = 'none'; // Prevent interference during drawing
        
        console.log('Created redaction box:', this.currentRedactionBox);
        this.redactionLayer.appendChild(this.currentRedactionBox);
        
        // Ensure we're tracking mouse movements
        console.log('Redaction started, isRedacting:', this.isRedacting);
    }

    drawRedaction(e) {
        console.log('=== MOUSE MOVE EVENT ===');
        console.log('isRedacting:', this.isRedacting);
        console.log('currentRedactionBox exists:', !!this.currentRedactionBox);
        
        if (!this.isRedacting || !this.currentRedactionBox) {
            console.log('Not redacting or no box, returning');
            return;
        }
        
        e.preventDefault();
        e.stopPropagation();
        
        const rect = this.canvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        
        const width = Math.abs(currentX - this.redactionStart.x);
        const height = Math.abs(currentY - this.redactionStart.y);
        const left = Math.min(currentX, this.redactionStart.x);
        const top = Math.min(currentY, this.redactionStart.y);
        
        console.log('Current mouse:', { currentX, currentY });
        console.log('Calculated box:', { left, top, width, height });
        
        this.currentRedactionBox.style.left = left + 'px';
        this.currentRedactionBox.style.top = top + 'px';
        this.currentRedactionBox.style.width = width + 'px';
        this.currentRedactionBox.style.height = height + 'px';
        
        console.log('Applied styles to box');
        
        // Show visual feedback for larger movements
        if (width > 2 || height > 2) {
            console.log('*** DRAWING REDACTION ***', { left, top, width, height });
        }
    }

    endRedaction() {
        console.log('=== MOUSE UP EVENT ===');
        console.log('isRedacting:', this.isRedacting);
        console.log('currentRedactionBox exists:', !!this.currentRedactionBox);
        
        if (!this.isRedacting || !this.currentRedactionBox) {
            console.log('Not redacting or no box, returning');
            return;
        }
        
        const width = parseInt(this.currentRedactionBox.style.width) || 0;
        const height = parseInt(this.currentRedactionBox.style.height) || 0;
        
        console.log('Final redaction size:', { width, height });
        
        // Much smaller minimum size for testing (was 5x5, now 2x2)
        if (width >= 2 && height >= 2) {
            const redaction = {
                pageIndex: this.currentPage - 1,
                x: parseInt(this.currentRedactionBox.style.left) || 0,
                y: parseInt(this.currentRedactionBox.style.top) || 0,
                width: width,
                height: height,
                viewportWidth: this.canvas.width,
                viewportHeight: this.canvas.height
            };
            
            this.redactions.push(redaction);
            console.log('*** REDACTION SAVED ***', redaction);
            console.log('Total redactions:', this.redactions.length);
            
            // Re-enable pointer events for clicking to remove
            this.currentRedactionBox.style.pointerEvents = 'all';
            
            // Add click handler to remove redaction
            this.currentRedactionBox.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeRedaction(redaction);
            });
            
            this.showStatus(`Redaction added (${this.redactions.length} total)`, 'info');
        } else {
            console.log('*** REDACTION TOO SMALL, REMOVING ***', { width, height });
            if (this.currentRedactionBox.parentNode) {
                this.redactionLayer.removeChild(this.currentRedactionBox);
            }
        }
        
        this.isRedacting = false;
        this.currentRedactionBox = null;
        console.log('Redaction ended, reset state');
    }

    removeRedaction(redaction) {
        const index = this.redactions.indexOf(redaction);
        if (index > -1) {
            this.redactions.splice(index, 1);
            this.renderRedactions();
            this.showStatus(`Redaction removed (${this.redactions.length} remaining)`, 'info');
        }
    }

    toggleRedactionMode() {
        const btn = document.getElementById('redactBtn');
        btn.classList.toggle('active');
        
        if (btn.classList.contains('active')) {
            btn.textContent = 'Redaction Tool (Active)';
            this.canvas.style.cursor = 'crosshair';
        } else {
            btn.textContent = 'Redaction Tool';
            this.canvas.style.cursor = 'default';
        }
    }

    clearRedactions() {
        this.redactions = [];
        this.renderRedactions();
        this.showStatus('All redactions cleared', 'info');
    }

    async savePDF() {
        if (!this.currentFilename) {
            this.showStatus('No PDF loaded', 'error');
            return;
        }

        if (this.redactions.length === 0) {
            this.showStatus('No redactions to apply', 'error');
            return;
        }

        try {
            this.showStatus('Applying redactions...', 'info');
            
            const response = await fetch('/redact', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    filename: this.currentFilename,
                    redactions: this.redactions
                })
            });

            const result = await response.json();

            if (response.ok) {
                this.showStatus('PDF redacted successfully!', 'success');
                
                // Create download link
                const downloadLink = document.createElement('a');
                downloadLink.href = result.downloadPath;
                downloadLink.download = result.redactedFilename;
                downloadLink.textContent = 'Download Redacted PDF';
                downloadLink.style.display = 'block';
                downloadLink.style.marginTop = '10px';
                downloadLink.style.color = '#27ae60';
                downloadLink.style.textDecoration = 'none';
                downloadLink.style.fontWeight = 'bold';
                
                const statusDiv = document.getElementById('statusDiv');
                statusDiv.appendChild(downloadLink);
                
                // Auto-download
                downloadLink.click();
            } else {
                this.showStatus(result.error || 'Redaction failed', 'error');
            }
        } catch (error) {
            console.error('Redaction error:', error);
            this.showStatus('Redaction failed. Please try again.', 'error');
        }
    }

    previousPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.renderPage();
            this.updatePageInfo();
        }
    }

    nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
            this.renderPage();
            this.updatePageInfo();
        }
    }

    updatePageInfo() {
        document.getElementById('pageInfo').textContent = `Page ${this.currentPage} of ${this.totalPages}`;
        document.getElementById('prevPage').disabled = this.currentPage === 1;
        document.getElementById('nextPage').disabled = this.currentPage === this.totalPages;
    }

    showStatus(message, type) {
        const statusDiv = document.getElementById('statusDiv');
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.style.display = 'block';
        
        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
        }
    }

    // Debug method to test redaction creation manually
    testRedaction() {
        console.log('Creating test redaction...');
        const testBox = document.createElement('div');
        testBox.className = 'redaction-box';
        testBox.style.position = 'absolute';
        testBox.style.left = '50px';
        testBox.style.top = '50px';
        testBox.style.width = '100px';
        testBox.style.height = '50px';
        testBox.style.zIndex = '10';
        this.redactionLayer.appendChild(testBox);
        
        const testRedaction = {
            pageIndex: this.currentPage - 1,
            x: 50,
            y: 50,
            width: 100,
            height: 50,
            viewportWidth: this.canvas.width,
            viewportHeight: this.canvas.height
        };
        
        this.redactions.push(testRedaction);
        console.log('Test redaction created:', testRedaction);
        this.showStatus('Test redaction created', 'info');
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.pdfApp = new PDFRedactionApp();
    console.log('PDF Redaction App initialized');
    console.log('Debug: You can access the app via window.pdfApp');
    console.log('Debug: Try window.pdfApp.testRedaction() to test redaction creation');
});