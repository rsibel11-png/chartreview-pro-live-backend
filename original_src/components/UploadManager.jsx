import React, { createContext, useContext, useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';
import { assessDocumentRelevance } from './utils/documentRelevance';

const UploadContext = createContext();

export const useUploadManager = () => {
  const context = useContext(UploadContext);
  if (!context) {
    throw new Error('useUploadManager must be used within UploadProvider');
  }
  return context;
};

export const UploadProvider = ({ children }) => {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  // Warn user before leaving the page during an active upload
  React.useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (uploading) {
        e.preventDefault();
        e.returnValue = 'Files are still uploading. If you leave, the remaining uploads will be cancelled.';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [uploading]);
  const [cancelUpload, setCancelUpload] = useState(false);
  const cancelUploadRef = React.useRef(false);
  const [progress, setProgress] = useState({});
  const [selectedFolder, setSelectedFolder] = useState('');

  const generateHash = async (content) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const checkForDuplicatePages = async (fileUrl) => {
    try {
      const prompt = `Carefully analyze this document and identify ONLY pages that are true exact duplicates — meaning the SAME page was scanned or included more than once.

      STRICT rules:
      1. Only flag pages where the content is virtually IDENTICAL (same text, same layout, same date, same patient info, same provider notes).
      2. DO NOT flag pages that are merely similar — e.g., two different office visit notes from the same provider are NOT duplicates even if they share headers, form templates, or doctor names.
      3. DO NOT flag pages that have the same form template but different clinical content or dates.
      4. DO NOT flag consecutive pages of a multi-page report as duplicates.
      5. A page is only a duplicate if it appears to be a literal re-scan or re-insertion of the exact same page.

      If you are not highly confident that two pages are exact duplicates, do NOT flag them.
      When in doubt, return has_duplicates: false.`;

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        file_urls: [fileUrl],
        response_json_schema: {
          type: "object",
          properties: {
            has_duplicates: { type: "boolean" },
            duplicate_groups: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  page_numbers: {
                    type: "array",
                    items: { type: "number" }
                  },
                  similarity: { type: "string" }
                }
              }
            }
          }
        }
      });

      if (result.has_duplicates && result.duplicate_groups?.length > 0) {
        result.page_thumbnails = {};
      }

      return result;
    } catch (error) {
      return { has_duplicates: false, duplicate_groups: [] };
    }
  };

  const processFilePart = async (file_url, fileName, originalFileSize, id, partLabel) => {
    // Core logic: given an already-uploaded file_url, assess and store as a Document
    const [extractResult, duplicatePages] = await Promise.all([
      assessDocumentRelevance(file_url).catch(() => ({
        category: 'uncategorized',
        subcategory: 'other',
        is_relevant_medical_document: true,
        extracted_text: `File uploaded: ${fileName}`,
        office_visit_count: 0,
        page_count: 1,
        rejection_reason: ''
      })),
      checkForDuplicatePages(file_url).catch(() => ({ has_duplicates: false, duplicate_groups: [] }))
    ]);

    const isRejected = extractResult.is_relevant_medical_document === false;
    const rejectionReason = extractResult.rejection_reason || 'Not related to actual medical treatment or office visits';
    const hashSource = `${fileName}-${originalFileSize}-${extractResult.document_date || 'no-date'}-${extractResult.extracted_text?.substring(0, 200)}`;
    const contentHash = await generateHash(hashSource);

    const existingDocs = await base44.entities.Document.list();
    let duplicate = existingDocs.find(doc => doc.content_hash === contentHash);
    if (!duplicate && extractResult.patient_name && extractResult.document_date) {
      duplicate = existingDocs.find(doc =>
        doc.patient_name === extractResult.patient_name &&
        doc.document_date === extractResult.document_date &&
        doc.title === fileName &&
        Math.abs(doc.file_size - originalFileSize) < 1024
      );
    }

    const visitCountNote = extractResult.office_visit_count && extractResult.office_visit_count > 1
      ? `Contains ${extractResult.office_visit_count} office visits. `
      : '';
    const pageCount = extractResult.page_count || 1;

    // Credit deduction
    const user = await base44.auth.me();
    if (user.role === 'admin') {
      await base44.auth.updateMe({ total_pages_processed: (user.total_pages_processed || 0) + pageCount });
    } else {
      let remainingPages = pageCount;
      const trialEnds = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
      const trialActive = trialEnds && new Date() < trialEnds;
      let trialBonus = trialActive ? (user.trial_bonus_pages || 0) : 0;
      if (trialBonus > 0) { const used = Math.min(trialBonus, remainingPages); trialBonus -= used; remainingPages -= used; }
      let freePages = user.free_pages_remaining || 0;
      if (remainingPages > 0 && freePages > 0) { const used = Math.min(freePages, remainingPages); freePages -= used; remainingPages -= used; }
      let credits = user.page_credits || 0;
      if (remainingPages > 0) {
        if (credits < remainingPages) throw new Error(`Insufficient page credits. Need ${remainingPages} more pages.`);
        credits -= remainingPages;
      }
      await base44.auth.updateMe({ trial_bonus_pages: trialBonus, free_pages_remaining: freePages, page_credits: credits, total_pages_processed: (user.total_pages_processed || 0) + pageCount });
    }

    const newDocument = await base44.entities.Document.create({
      title: fileName,
      file_url,
      file_type: 'application/pdf',
      file_size: originalFileSize,
      page_count: pageCount,
      folder: isRejected ? 'Rejected Documents' : (selectedFolder || null),
      category: extractResult.category || 'uncategorized',
      subcategory: extractResult.subcategory,
      patient_name: extractResult.patient_name,
      document_date: extractResult.document_date,
      provider_name: extractResult.provider_name,
      case_number: extractResult.case_number,
      extracted_text: extractResult.extracted_text,
      content_hash: contentHash,
      is_duplicate: !!duplicate,
      duplicate_of: duplicate?.id,
      has_duplicate_pages: duplicatePages.has_duplicates || false,
      duplicate_pages: duplicatePages.duplicate_groups || [],
      page_thumbnails: duplicatePages.page_thumbnails || {},
      duplicate_pages_reviewed: false,
      is_rejected: isRejected,
      rejection_reason: isRejected ? rejectionReason : '',
      original_folder: isRejected ? (selectedFolder || null) : null,
      processing_status: 'completed',
      notes: visitCountNote + (extractResult.notes || ''),
    });

    return { success: true, document: newDocument, isRejected };
  };

  const SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

  const processFile = async (fileData) => {
    const { file, id } = fileData;
    
    try {
      setProgress(prev => ({ ...prev, [id]: 10 }));
      
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setProgress(prev => ({ ...prev, [id]: 30 }));

      // If file is > 10 MB, auto-split it and process each part
      if (file.size > SIZE_LIMIT && file.type === 'application/pdf') {
        setProgress(prev => ({ ...prev, [id]: 35 }));
        setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'splitting' } : f));

        const splitResponse = await base44.functions.invoke('splitPdf', {
          file_url,
          original_filename: file.name,
        });

        const parts = splitResponse.data?.parts || [];
        if (parts.length === 0) throw new Error('Failed to split PDF — no parts returned.');

        setProgress(prev => ({ ...prev, [id]: 40 }));

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          await processFilePart(part.file_url, part.filename, part.size_bytes, id, `Part ${i + 1}`);
          setProgress(prev => ({ ...prev, [id]: 40 + Math.round(((i + 1) / parts.length) * 55) }));
        }

        setProgress(prev => ({ ...prev, [id]: 100 }));
        setFiles(prev => prev.map(f =>
          f.id === id ? { ...f, status: 'completed', splitIntoParts: parts.length, errorMessage: null } : f
        ));
        queryClient.invalidateQueries({ queryKey: ['documents'] });
        return { success: true };
      }

      setProgress(prev => ({ ...prev, [id]: 40 }));

      // Process as a single document (under 10 MB)
      const result = await processFilePart(file_url, file.name, file.size, id, null);
      const { document: newDocument, isRejected } = result;

      setProgress(prev => ({ ...prev, [id]: 100 }));
      setFiles(prev => prev.map(f => 
        f.id === id ? { 
          ...f, 
          status: 'completed', 
          isDuplicate: newDocument.is_duplicate,
          hasDuplicatePages: newDocument.has_duplicate_pages,
          documentId: newDocument.id,
          isRejected,
          errorMessage: null,
        } : f
      ));

      queryClient.invalidateQueries({ queryKey: ['documents'] });

      return { success: true, document: newDocument, isRejected };
    } catch (err) {
      const errorMessage = err.message || String(err);
      setFiles(prev => prev.map(f => 
        f.id === id ? { ...f, status: 'error', errorMessage } : f
      ));
      return { success: false, error: errorMessage };
    }
  };

  const uploadAll = useCallback(async () => {
    // Check user credits before starting upload
    try {
      const user = await base44.auth.me();
      const trialEnds = user.trial_ends_at ? new Date(user.trial_ends_at) : null;
      const trialActive = trialEnds && new Date() < trialEnds;
      const trialBonus = trialActive ? (user.trial_bonus_pages || 0) : 0;
      const freePages = user.free_pages_remaining || 0;
      const credits = user.page_credits || 0;
      const totalAvailable = trialBonus + freePages + credits;

      // Admins skip low-credit warnings
      if (user.role !== 'admin' && totalAvailable <= 250) {
        const confirmUpload = window.confirm(
          `⚠️ Low Page Credits Warning\n\nYou have only ${totalAvailable} pages remaining.\n\nWe recommend purchasing more page credits to avoid running out during processing.\n\nClick OK to continue uploading anyway, or Cancel to purchase more credits first.`
        );
        
        if (!confirmUpload) {
          return;
        }
      }
    } catch (error) {
      console.error("Failed to check credits:", error);
    }

    setUploading(true);
    setCancelUpload(false);
    cancelUploadRef.current = false;
    const pendingFiles = files.filter(f => f.status === 'pending');

    // Rolling concurrency pool — always keep up to 3 uploads active
    const CONCURRENCY = 3;
    const queue = [...pendingFiles];
    let active = 0;

    await new Promise((resolve) => {
      const next = () => {
        if (cancelUploadRef.current) {
          setFiles(prev => prev.map(f =>
            f.status === 'pending' ? { ...f, status: 'cancelled', errorMessage: 'Upload cancelled by user' } : f
          ));
          if (active === 0) resolve();
          return;
        }
        while (active < CONCURRENCY && queue.length > 0) {
          const fileData = queue.shift();
          active++;
          processFile(fileData).finally(() => {
            active--;
            if (queue.length > 0 && !cancelUploadRef.current) {
              next();
            } else if (active === 0) {
              resolve();
            }
          });
        }
        if (active === 0 && queue.length === 0) resolve();
      };
      next();
    });
    
    setUploading(false);
    setCancelUpload(false);
    cancelUploadRef.current = false;
  }, [files, cancelUpload, selectedFolder]);

  const addFiles = useCallback((newFiles) => {
    const filesWithData = newFiles.map(file => {
      const nameParts = file.name.split('.');
      if (nameParts.length > 1) {
        const ext = nameParts.pop().toLowerCase();
        nameParts.push(ext);
      }
      const normalizedName = nameParts.join('.');

      return {
        file,
        id: Math.random().toString(36).substr(2, 9),
        status: 'pending',
        name: normalizedName,
        size: file.size,
        type: file.type || 'application/octet-stream',
        errorMessage: null,
      };
    });
    setFiles(prev => [...prev, ...filesWithData]);
  }, []);

  const removeFile = useCallback((fileId) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
  }, []);

  const stopUpload = useCallback(() => {
    setCancelUpload(true);
    cancelUploadRef.current = true;
  }, []);

  const clearCompleted = useCallback(() => {
    setFiles(prev => prev.filter(f => f.status !== 'completed'));
    setProgress({});
  }, []);

  const value = {
    files,
    uploading,
    cancelUpload,
    progress,
    selectedFolder,
    setSelectedFolder,
    addFiles,
    removeFile,
    uploadAll,
    stopUpload,
    clearCompleted,
    setFiles,
  };

  return (
    <UploadContext.Provider value={value}>
      {children}
    </UploadContext.Provider>
  );
};