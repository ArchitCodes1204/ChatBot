import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import Tesseract from 'tesseract.js';
import * as mammoth from 'mammoth';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const extractTextFromFile = async (file) => {
  const fileType = file.type;
  const fileName = file.name.toLowerCase();

  try {
    // Plain Text
    if (fileType === 'text/plain') {
      return await file.text();
    }
    
    // PDF
    if (fileType === 'application/pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        text += `\n--- Page ${i} ---\n` + pageText + '\n';
      }
      return text;
    }

    // DOCX
    if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    }

    // Images
    if (fileType.startsWith('image/')) {
      // Perform OCR
      const result = await Tesseract.recognize(file, 'eng');
      return result.data.text;
    }

    throw new Error('Unsupported file type. Please upload a PDF, DOCX, TXT, or Image (PNG/JPG).');
  } catch (error) {
    console.error('Error parsing file:', error);
    throw new Error(`Failed to extract text from ${file.name}: ${error.message}`);
  }
};
