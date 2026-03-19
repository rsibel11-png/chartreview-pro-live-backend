import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, FileText, X, Trash2, Loader2, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";



export default function DuplicatePagesDialog({ document, onClose }) {
  const queryClient = useQueryClient();
  const [reviewedGroups, setReviewedGroups] = useState(new Set());
  const [pagesToDelete, setPagesToDelete] = useState(new Set());
  const [isRemoving, setIsRemoving] = useState(false);
  const [previewGroup, setPreviewGroup] = useState(null);
  const [extractedPageUrls, setExtractedPageUrls] = useState({});
  const [loadingPages, setLoadingPages] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [deleteOriginal, setDeleteOriginal] = useState(false);

  const markAsReviewedMutation = useMutation({
    mutationFn: () => base44.entities.Document.update(document.id, {
      duplicate_pages_reviewed: true
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      onClose();
    },
  });

  const toggleGroupReview = (index) => {
    setReviewedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const togglePageDeletion = (pageNum) => {
    setPagesToDelete(prev => {
      const newSet = new Set(prev);
      if (newSet.has(pageNum)) {
        newSet.delete(pageNum);
      } else {
        newSet.add(pageNum);
      }
      return newSet;
    });
  };

  const selectAllDuplicatesInGroup = (group) => {
    setPagesToDelete(prev => {
      const newSet = new Set(prev);
      // Add all pages except the first one (keep the first occurrence)
      group.page_numbers?.slice(1).forEach(pageNum => {
        newSet.add(pageNum);
      });
      return newSet;
    });
  };

  const selectAllDuplicatesInAllGroups = () => {
    const allDuplicatePages = new Set();
    document.duplicate_pages?.forEach(group => {
      // Add all pages except the first one in each group
      group.page_numbers?.slice(1).forEach(pageNum => {
        allDuplicatePages.add(pageNum);
      });
    });
    setPagesToDelete(allDuplicatePages);
  };

  const totalDuplicatePages = document.duplicate_pages?.reduce((count, group) => {
    return count + (group.page_numbers?.length > 1 ? group.page_numbers.length - 1 : 0);
  }, 0) || 0;

  const removeDuplicatePages = async () => {
    setIsRemoving(true);
    try {
      const pagesToRemove = Array.from(pagesToDelete).sort((a, b) => a - b);
      
      // Call backend function to remove pages from PDF
      const response = await base44.functions.invoke('removePdfPages', {
        file_url: document.file_url,
        pages_to_remove: pagesToRemove
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to remove pages');
      }

      // The backend function now returns the file_url directly
      const newFileUrl = response.data.file_url;

      if (!newFileUrl) {
        throw new Error('No file URL returned from deduplication process');
      }

      // Create new document with deduplicated content
      const newTitle = document.title.replace(/\.(pdf)$/i, '_deduplicated$&');
      
      const newDocument = await base44.entities.Document.create({
        title: newTitle,
        file_url: newFileUrl,
        file_type: document.file_type,
        file_size: document.file_size,
        folder: document.folder,
        category: document.category,
        subcategory: document.subcategory,
        patient_name: document.patient_name,
        document_date: document.document_date,
        provider_name: document.provider_name,
        case_number: document.case_number,
        content_hash: document.content_hash + '_dedup',
        has_duplicate_pages: false,
        duplicate_pages: [],
        duplicate_pages_reviewed: true,
        processing_status: 'completed',
        notes: `Deduplicated version of "${document.title}". Removed pages: ${pagesToRemove.join(', ')}. Original: ${response.data.originalPageCount} pages, New: ${response.data.newPageCount} pages.`
      });

      if (!newDocument || !newDocument.id) {
        throw new Error('Failed to create deduplicated document record');
      }

      // Delete or mark original document based on user preference
      if (deleteOriginal) {
        await base44.entities.Document.delete(document.id);
      } else {
        await base44.entities.Document.update(document.id, {
          duplicate_pages_reviewed: true,
          notes: `Duplicate pages detected and removed. See deduplicated version: "${newTitle}"`
        });
      }

      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      
      onClose();
    } catch (error) {
      console.error("Error removing duplicate pages:", error);
      alert("Failed to remove duplicate pages: " + error.message);
      setIsRemoving(false);
    }
  };

  const allReviewed = reviewedGroups.size === (document.duplicate_pages?.length || 0);
  const hasPagesToDelete = pagesToDelete.size > 0;

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] overflow-y-auto flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-amber-600" />
            </div>
            <div>
              <DialogTitle className="text-2xl">Duplicate Pages Detected</DialogTitle>
              <DialogDescription className="mt-1">
                This document contains pages that appear multiple times
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-1 gap-4 overflow-hidden">
          {/* Left Sidebar */}
          <div className="w-40 flex-shrink-0 bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-3 overflow-y-auto">
            <div>
              <h4 className="font-semibold text-slate-900 text-sm mb-2">Group Actions</h4>
              <Button
                variant="outline"
                size="sm"
                onClick={selectAllDuplicatesInAllGroups}
                className="w-full justify-start text-xs h-9 bg-white"
              >
                <CheckCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                <span className="truncate">Select All ({totalDuplicatePages})</span>
              </Button>
            </div>

            <div className="border-t border-slate-200 pt-3">
              <h4 className="font-semibold text-slate-900 text-sm mb-2">Delete Options</h4>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-slate-100 text-xs">
                  <Checkbox
                    id="delete-original-sidebar"
                    checked={deleteOriginal}
                    onCheckedChange={setDeleteOriginal}
                    className="mt-0.5"
                  />
                  <span className="text-slate-700 font-medium">Delete original after deduplication</span>
                </label>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-3">
              <h4 className="font-semibold text-slate-900 text-sm mb-2">Mark Reviewed</h4>
              <Button
                onClick={() => markAsReviewedMutation.mutate()}
                disabled={!allReviewed || markAsReviewedMutation.isLoading}
                variant={allReviewed ? "default" : "outline"}
                size="sm"
                className="w-full justify-start text-xs h-9"
              >
                {allReviewed ? (
                  <>
                    <CheckCircle className="w-3 h-3 mr-1 flex-shrink-0" />
                    <span className="truncate">Mark Reviewed</span>
                  </>
                ) : (
                  <span className="truncate text-slate-500 text-xs">Review all groups</span>
                )}
              </Button>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto space-y-4">
          {/* Document Info */}
          <Card className="bg-slate-50">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-slate-600 mt-0.5" />
                <div className="flex-1">
                  <h4 className="font-semibold text-slate-900">{document.title}</h4>
                  <div className="flex flex-wrap gap-3 mt-2 text-sm text-slate-600">
                    {document.patient_name && (
                      <span>Patient: {document.patient_name}</span>
                    )}
                    {document.case_number && (
                      <span>Case: {document.case_number}</span>
                    )}
                  </div>
                </div>
                <Badge className="bg-amber-600">
                  {document.duplicate_pages?.length || 0} duplicate group{document.duplicate_pages?.length !== 1 ? 's' : ''}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {hasPagesToDelete && (
            <Card className="bg-red-50 border-red-200">
              <CardContent className="p-4">
                <div className="flex items-start gap-2">
                  <Trash2 className="w-5 h-5 text-red-600 mt-0.5" />
                  <div>
                    <p className="font-semibold text-red-900">
                      {pagesToDelete.size} page{pagesToDelete.size !== 1 ? 's' : ''} selected for removal
                    </p>
                    <p className="text-sm text-red-700 mt-1">
                      Pages: {Array.from(pagesToDelete).sort((a, b) => a - b).join(', ')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Duplicate Groups */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Review and Select Pages to Remove</h3>
            
            {document.duplicate_pages?.map((group, index) => (
              <Card 
                key={index} 
                className={`border-2 transition-all ${
                  reviewedGroups.has(index) 
                    ? 'border-green-300 bg-green-50' 
                    : 'border-amber-200 bg-amber-50'
                }`}
              >
                <CardContent className="p-4">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h4 className="font-semibold text-slate-900">
                            Group {index + 1}
                          </h4>
                          {reviewedGroups.has(index) && (
                            <CheckCircle className="w-5 h-5 text-green-600" />
                          )}
                        </div>
                        
                        <div className="space-y-2">
                          <div>
                            <span className="text-sm font-medium text-slate-700">Similarity: </span>
                            <p className="text-sm text-slate-600 mt-1">{group.similarity}</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100 text-xs h-8"
                          disabled={loadingPages}
                          onClick={async () => {
                            if (previewGroup === index) {
                              setPreviewGroup(null);
                              setPreviewError(null);
                            } else {
                              setPreviewGroup(index);
                              setPreviewError(null);
                              // Extract individual pages as PDFs
                              const pageNums = group.page_numbers || [];
                              const missingPages = pageNums.filter(p => !extractedPageUrls[p]);

                              if (missingPages.length > 0) {
                                setLoadingPages(true);
                                try {
                                  const response = await base44.functions.invoke('extractPdfPages', {
                                    file_url: document.file_url,
                                    page_numbers: missingPages,
                                    extract_as_pdf: true
                                  });

                                  if (response.data.success && response.data.extractedPages) {
                                    const newUrls = {};
                                    for (const page of response.data.extractedPages) {
                                      try {
                                        const binaryStr = atob(page.pdfBase64);
                                        const bytes = new Uint8Array(binaryStr.length);
                                        for (let i = 0; i < binaryStr.length; i++) {
                                          bytes[i] = binaryStr.charCodeAt(i);
                                        }
                                        const blob = new Blob([bytes], { type: 'application/pdf' });
                                        newUrls[page.pageNumber] = URL.createObjectURL(blob);
                                      } catch (e) {
                                        console.error('Error creating blob for page', page.pageNumber, e);
                                      }
                                    }
                                    setExtractedPageUrls(prev => ({ ...prev, ...newUrls }));
                                  } else {
                                    setPreviewError(response.data?.error || 'Failed to extract pages');
                                  }
                                } catch (err) {
                                  console.error('Failed to extract pages:', err);
                                  setPreviewError(err.message || 'Failed to extract pages');
                                }
                                setLoadingPages(false);
                              }
                            }
                          }}
                        >
                          {loadingPages && previewGroup === index ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          ) : (
                            <Eye className="w-3 h-3 mr-1" />
                          )}
                          {previewGroup === index ? 'Hide' : 'Preview'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => selectAllDuplicatesInGroup(group)}
                          className="text-xs h-8"
                        >
                          Select
                        </Button>
                        <Button
                          variant={reviewedGroups.has(index) ? "outline" : "default"}
                          size="sm"
                          onClick={() => toggleGroupReview(index)}
                          className={`text-xs h-8 ${reviewedGroups.has(index) ? '' : 'bg-green-600 hover:bg-green-700'}`}
                        >
                          {reviewedGroups.has(index) ? 'Unmark' : 'Mark'}
                        </Button>
                      </div>
                    </div>

                    {/* Side-by-side PDF Preview */}
                    {previewGroup === index && (
                      <div className="border-t pt-3">
                        <span className="text-sm font-medium text-slate-700 mb-2 block">
                          Side-by-Side Comparison:
                        </span>
                        {previewError && (
                          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-red-700 text-sm">
                            Error loading preview: {previewError}
                          </div>
                        )}
                        <div className="flex gap-4 overflow-x-auto pb-2">
                          {(() => {
                            // Group consecutive pages together
                            const pageGroups = [];
                            let currentGroup = [];
                            
                            const sortedPages = [...(group.page_numbers || [])].sort((a, b) => a - b);
                            
                            sortedPages.forEach((pageNum, idx) => {
                              if (idx === 0 || pageNum === sortedPages[idx - 1] + 1) {
                                currentGroup.push(pageNum);
                              } else {
                                pageGroups.push([...currentGroup]);
                                currentGroup = [pageNum];
                              }
                            });
                            if (currentGroup.length > 0) {
                              pageGroups.push(currentGroup);
                            }
                            
                            return pageGroups.map((pageGroup, groupIdx) => {
                              const isOriginal = groupIdx === 0;
                              const hasMarkedForDeletion = pageGroup.some(p => pagesToDelete.has(p));
                              
                              return (
                                <div 
                                  key={groupIdx}
                                  className={`flex-1 min-w-[400px] rounded-lg border-2 overflow-hidden ${
                                    isOriginal
                                      ? 'border-blue-400'
                                      : hasMarkedForDeletion
                                      ? 'border-red-400'
                                      : 'border-orange-300'
                                  }`}
                                >
                                  <div className={`px-3 py-2 text-sm font-medium text-center ${
                                    isOriginal
                                      ? 'bg-blue-200 text-blue-800'
                                      : hasMarkedForDeletion
                                      ? 'bg-red-200 text-red-800'
                                      : 'bg-orange-200 text-orange-800'
                                  }`}>
                                    Pages {pageGroup[0]}-{pageGroup[pageGroup.length - 1]} {isOriginal ? '(Original)' : '(Duplicate)'}
                                  </div>
                                  <div className="overflow-y-auto bg-white" style={{ height: '70vh' }}>
                                    {pageGroup.map((pageNum) => (
                                      <div key={pageNum} className="border-b border-slate-200 last:border-b-0">
                                        {extractedPageUrls[pageNum] ? (
                                          <object
                                            data={extractedPageUrls[pageNum]}
                                            type="application/pdf"
                                            className="w-full bg-white"
                                            style={{ height: '500px' }}
                                          >
                                            <iframe
                                              src={extractedPageUrls[pageNum]}
                                              className="w-full border-0 bg-white"
                                              style={{ height: '500px' }}
                                              title={`Page ${pageNum}`}
                                            />
                                          </object>
                                        ) : document.page_thumbnails?.[pageNum]?.image_url ? (
                                          <div className="w-full flex flex-col items-center justify-center bg-white p-4" style={{ minHeight: '400px' }}>
                                            <div className="text-xs text-slate-500 mb-2">Page {pageNum}</div>
                                            <img 
                                              src={document.page_thumbnails[pageNum].image_url}
                                              alt={`Page ${pageNum} preview`}
                                              className="max-w-full object-contain shadow-lg rounded"
                                              onError={(e) => {
                                                e.target.style.display = 'none';
                                                e.target.nextElementSibling.style.display = 'block';
                                              }}
                                            />
                                            <div style={{ display: 'none' }} className="text-center">
                                              <span className="text-sm text-red-500">Failed to load thumbnail</span>
                                              {document.page_thumbnails[pageNum].description && (
                                                <p className="text-xs text-slate-600 mt-2 max-w-md">
                                                  {document.page_thumbnails[pageNum].description}
                                                </p>
                                              )}
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="w-full flex flex-col items-center justify-center bg-slate-100" style={{ minHeight: '400px' }}>
                                            <div className="text-xs text-slate-500 mb-2">Page {pageNum}</div>
                                            {loadingPages && previewGroup === index ? (
                                              <>
                                                <Loader2 className="w-8 h-8 animate-spin text-slate-400 mb-2" />
                                                <span className="text-sm text-slate-500">Extracting...</span>
                                              </>
                                            ) : previewError ? (
                                              <span className="text-sm text-red-500">Failed to load</span>
                                            ) : (
                                              <span className="text-sm text-slate-500">Click Preview to load</span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Page Selection */}
                    <div className="border-t pt-3">
                      <span className="text-sm font-medium text-slate-700 mb-2 block">
                        Select pages to delete:
                      </span>
                      <div className="flex flex-wrap gap-3">
                        {group.page_numbers?.map((pageNum, idx) => {
                          const sortedPages = [...(group.page_numbers || [])].sort((a, b) => a - b);
                          const isFirst = pageNum === sortedPages[0];
                          
                          return (
                            <div 
                              key={pageNum}
                              className={`flex items-center gap-2 p-2 rounded border ${
                                pagesToDelete.has(pageNum)
                                  ? 'bg-red-100 border-red-300'
                                  : isFirst
                                  ? 'bg-blue-50 border-blue-200'
                                  : 'bg-white border-slate-200'
                              }`}
                            >
                              <Checkbox
                                 id={`page-${pageNum}`}
                                 checked={pagesToDelete.has(pageNum)}
                                 onCheckedChange={() => togglePageDeletion(pageNum)}
                               />
                               <label
                                 htmlFor={`page-${pageNum}`}
                                 className="text-sm font-medium cursor-pointer text-slate-900"
                               >
                                 Page {pageNum}
                                 {isFirst && !pagesToDelete.has(pageNum) && <span className="text-xs ml-1 text-blue-600">(original)</span>}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Separator />

          {/* Instructions */}
          <Card className="bg-blue-50 border-blue-200">
            <CardContent className="p-4">
              <h4 className="font-semibold text-blue-900 mb-2 text-sm">Instructions:</h4>
              <ul className="text-xs text-blue-800 space-y-1 list-disc list-inside">
                <li>Review each group of duplicate pages</li>
                <li>Select which duplicate pages you want to remove</li>
                <li>First occurrence in each group is kept by default</li>
                <li>Create deduplicated version and optionally delete original</li>
              </ul>
            </CardContent>
          </Card>
          </div>
          </div>

          {/* Footer Actions */}
          <div className="flex justify-between items-center pt-4 border-t gap-4 flex-wrap px-6 py-4">
          <Button variant="outline" onClick={onClose} size="sm">
            <X className="w-4 h-4 mr-2" />
            Close
          </Button>

          <Button
            onClick={removeDuplicatePages}
            disabled={!hasPagesToDelete || isRemoving}
            className="bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700"
            size="sm"
          >
            {isRemoving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Removing Pages...
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4 mr-2" />
                Remove {pagesToDelete.size > 0 ? `(${pagesToDelete.size})` : ''}
              </>
            )}
          </Button>
          </div>
          </DialogContent>
          </Dialog>
          );
          }