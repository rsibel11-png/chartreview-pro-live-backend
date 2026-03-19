import React, { useState, useCallback, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload as UploadIcon, FileText, X, CheckCircle, Loader2, AlertCircle, File, Image, Archive, StopCircle, Trash2, CheckSquare, Square, Folder, Scissors } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import DuplicatePagesDialog from "../components/upload/DuplicatePagesDialog";
import PagePaymentDialog from "../components/upload/PagePaymentDialog";
import { useUploadManager } from "../components/UploadManager";

export default function Upload() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { 
    files, 
    uploading,
    cancelUpload,
    progress, 
    selectedFolder, 
    setSelectedFolder,
    addFiles: addFilesToManager,
    removeFile,
    uploadAll,
    stopUpload,
    clearCompleted,
    setFiles
  } = useUploadManager();
  
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);
  const [documentWithDuplicates, setDocumentWithDuplicates] = useState(null);
  const [selectedForDeletion, setSelectedForDeletion] = useState(new Set());
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [estimatedPageCount, setEstimatedPageCount] = useState(0);
  const [scanningPages, setScanningPages] = useState(false);

  const { data: documents = [] } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list('-created_date', 1000),
    initialData: [],
  });

  const existingFolders = [...new Set(documents.map(d => d.folder).filter(Boolean))].sort();

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    addFilesToManager(droppedFiles);
    setError(null);
  }, [addFilesToManager]);

  const handleFileInput = (e) => {
    const selectedFiles = Array.from(e.target.files);
    addFilesToManager(selectedFiles);
    setError(null);
  };

  const getFileIcon = (type) => {
    if (type.startsWith('image/')) return Image;
    if (type.includes('zip') || type.includes('compressed')) return Archive;
    return FileText;
  };

  // Watch for documents with duplicate pages
  useEffect(() => {
    const docWithDups = files.find(f => f.hasDuplicatePages && f.status === 'completed' && f.documentId);
    if (docWithDups && docWithDups.documentId) {
      // Fetch the full document to show in dialog
      base44.entities.Document.filter({ id: docWithDups.documentId }).then(docs => {
        if (docs[0]) {
          setDocumentWithDuplicates(docs[0]);
        }
      });
    }
  }, [files]);

  // Fast client-side page count (reads file locally, no upload needed)
  const countPdfPages = async (file) => {
    if (!file.type.includes('pdf')) {
      // Rough estimate for non-PDFs: ~100KB per page
      return Math.max(1, Math.round(file.size / 100000));
    }
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buffer);
      const matches = text.match(/\/Type\s*\/Page[^s]/g);
      return matches ? matches.length : Math.max(1, Math.round(file.size / 100000));
    } catch {
      return Math.max(1, Math.round(file.size / 100000));
    }
  };

  const scanAndShowPayment = async () => {
    setScanningPages(true);
    setError(null);
    try {
      const pendingFiles = files.filter(f => f.status === 'pending');
      const pageCounts = await Promise.all(pendingFiles.map(f => countPdfPages(f.file)));
      const totalPages = pageCounts.reduce((sum, n) => sum + n, 0);
      setEstimatedPageCount(totalPages);
      setShowPaymentDialog(true);
    } catch (err) {
      setError("Failed to scan pages: " + err.message);
    } finally {
      setScanningPages(false);
    }
  };

  const handlePaymentProceed = (mode) => {
    setShowPaymentDialog(false);
    if (mode === 'credits' || mode === 'stripe_paid') {
      uploadAll();
    }
  };

  const allCompleted = files.length > 0 && files.every(f => f.status === 'completed' || f.status === 'error' || f.status === 'cancelled') && !files.some(f => f.status === 'splitting');
  const hasDuplicatePages = files.some(f => f.hasDuplicatePages && f.status === 'completed');
  const hasErrors = files.some(f => f.status === 'error');
  const duplicateFiles = files.filter(f => f.isDuplicate && f.status === 'completed');
  const allDuplicatesSelected = duplicateFiles.length > 0 && duplicateFiles.every(f => selectedForDeletion.has(f.documentId));
  const someDuplicatesSelected = duplicateFiles.some(f => selectedForDeletion.has(f.documentId));

  const toggleDuplicateSelection = (documentId) => {
    setSelectedForDeletion(prev => {
      const newSet = new Set(prev);
      if (newSet.has(documentId)) {
        newSet.delete(documentId);
      } else {
        newSet.add(documentId);
      }
      return newSet;
    });
  };

  const selectAllDuplicates = () => {
    const duplicateIds = duplicateFiles.map(f => f.documentId);
    setSelectedForDeletion(new Set(duplicateIds));
  };

  const deselectAllDuplicates = () => {
    setSelectedForDeletion(new Set());
  };

  const deleteSelected = async () => {
    try {
      await Promise.all(
        Array.from(selectedForDeletion).map(docId => 
          base44.entities.Document.delete(docId)
        )
      );
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setFiles(prev => prev.filter(f => !selectedForDeletion.has(f.documentId)));
      setSelectedForDeletion(new Set());
    } catch (err) {
      console.error('Error deleting documents:', err);
      setError('Failed to delete some documents: ' + err.message);
    }
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Upload Documents</h1>
          <p className="text-slate-600 mt-1">Upload medical and legal documents in any format</p>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate(createPageUrl("Dashboard"))}
        >
          Back to Dashboard
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {hasErrors && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Some files failed to process. Check the error details below and try uploading again.
          </AlertDescription>
        </Alert>
      )}

      {hasDuplicatePages && (
        <Alert className="bg-amber-50 border-amber-200">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            Some documents contain duplicate pages. Review them to identify which pages to keep.
          </AlertDescription>
        </Alert>
      )}

      {duplicateFiles.length > 0 && (
        <Card className="border-2 border-orange-200 bg-orange-50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={allDuplicatesSelected ? deselectAllDuplicates : selectAllDuplicates}
                  className="bg-white"
                >
                  {allDuplicatesSelected ? (
                    <>
                      <CheckSquare className="w-4 h-4 mr-2" />
                      Deselect All
                    </>
                  ) : (
                    <>
                      <Square className="w-4 h-4 mr-2" />
                      Select All Duplicates ({duplicateFiles.length})
                    </>
                  )}
                </Button>
                {someDuplicatesSelected && !allDuplicatesSelected && (
                  <span className="text-sm text-orange-700">
                    {selectedForDeletion.size} of {duplicateFiles.length} selected
                  </span>
                )}
                {allDuplicatesSelected && (
                  <Badge variant="secondary" className="bg-orange-600 text-white">
                    All {duplicateFiles.length} duplicates selected
                  </Badge>
                )}
              </div>
              {selectedForDeletion.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={deleteSelected}
                  className="bg-red-600 hover:bg-red-700"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Selected ({selectedForDeletion.size})
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}



      {/* Folder Selection */}
      <Card className="shadow-md border-2 border-blue-100">
        <CardContent className="p-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Folder className="w-5 h-5 text-blue-600" />
              <label className="text-sm font-semibold text-slate-900">
                Destination Folder (Optional)
              </label>
            </div>
            <Input
              placeholder="Enter folder name (e.g., Case #12345, John Doe) or leave empty"
              value={selectedFolder}
              onChange={(e) => setSelectedFolder(e.target.value)}
              className="text-base"
            />
            {existingFolders.length > 0 && (
              <div>
                <p className="text-xs text-slate-500 mb-2">Or select existing folder:</p>
                <div className="flex flex-wrap gap-2">
                  {existingFolders.map(folder => (
                    <Button
                      key={folder}
                      variant={selectedFolder === folder ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSelectedFolder(folder)}
                      className={selectedFolder === folder ? "bg-blue-600" : ""}
                    >
                      <Folder className="w-3 h-3 mr-1" />
                      {folder}
                    </Button>
                  ))}
                  {selectedFolder && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedFolder("")}
                      className="text-red-600 border-red-300 hover:bg-red-50"
                    >
                      <X className="w-3 h-3 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            )}
            <p className="text-xs text-slate-500">
              All uploaded documents will be saved to {selectedFolder ? `"${selectedFolder}"` : 'no folder (unfiled)'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* File Size Info */}
      <Card className="shadow-md border border-blue-100 bg-blue-50">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-2">
              <p className="text-sm font-semibold text-blue-900">Maximum file size: 50MB per file</p>
              <p className="text-sm text-blue-800">PDF files over 10 MB are automatically split into smaller parts during upload. If your file exceeds 50MB, you'll need to compress or split it first. Here are free tools to help:</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                {/* AFFILIATE LINK ZONE — replace hrefs below with your personal affiliate URLs */}
                {/* Adobe: adobe.com/affiliates | Smallpdf: smallpdf.com/affiliate | iLovePDF: ilovepdf.com/affiliate */}
                <div className="bg-white rounded-lg p-3 border border-blue-200">
                  <p className="text-sm font-semibold text-slate-800">Adobe Acrobat</p>
                  <p className="text-xs text-slate-500 mb-2">Industry standard — compress, split & edit</p>
                  <div className="space-y-1">
                    {/* Replace href with your Adobe affiliate link */}
                    <a href="https://www.adobe.com/acrobat/online/compress-pdf.html" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Compress PDF (free online)</a>
                    <a href="https://www.adobe.com/acrobat/online/split-pdf.html" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Split PDF (free online)</a>
                    <a href="https://acrobat.adobe.com/" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Acrobat Pro (full suite)</a>
                  </div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-200">
                  <p className="text-sm font-semibold text-slate-800">Smallpdf</p>
                  <p className="text-xs text-slate-500 mb-2">Easy online tools — compress & split</p>
                  <div className="space-y-1">
                    {/* Replace href with your Smallpdf affiliate link */}
                    <a href="https://smallpdf.com/compress-pdf" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Compress PDF</a>
                    <a href="https://smallpdf.com/split-pdf" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Split PDF</a>
                    <a href="https://smallpdf.com/" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ All PDF tools</a>
                  </div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-200">
                  <p className="text-sm font-semibold text-slate-800">iLovePDF</p>
                  <p className="text-xs text-slate-500 mb-2">Free online PDF tools — no install needed</p>
                  <div className="space-y-1">
                    {/* Replace href with your iLovePDF affiliate link */}
                    <a href="https://www.ilovepdf.com/compress_pdf" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Compress PDF</a>
                    <a href="https://www.ilovepdf.com/split_pdf" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ Split PDF</a>
                    <a href="https://www.ilovepdf.com/" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block">→ All PDF tools</a>
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-1">⚠️ Note: For files containing sensitive patient data, desktop apps are recommended over online tools.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon className="w-5 h-5" />
            Select Files
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-12 transition-all duration-300 ${
              dragActive 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-slate-300 hover:border-slate-400 bg-slate-50'
            }`}
          >
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-4 bg-gradient-to-br from-blue-100 to-cyan-100 rounded-2xl flex items-center justify-center">
                <UploadIcon className="w-10 h-10 text-blue-600" />
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                Drop files here or click to browse
              </h3>
              <p className="text-slate-600 mb-2">
                All file types supported
              </p>
              <p className="text-sm text-slate-500 mb-6">
                PDF, DOC, DOCX, images (JPG, PNG, TIFF), ZIP archives, and more
              </p>
              <input
                type="file"
                multiple
                onChange={handleFileInput}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload">
                <Button asChild className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700">
                  <span>
                    <File className="w-4 h-4 mr-2" />
                    Choose Files
                  </span>
                </Button>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      {files.length > 0 && (
        <Card className="shadow-lg">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Files ({files.length})</CardTitle>
              <div className="flex gap-2">
                {files.some(f => f.status === 'pending') && !uploading && !scanningPages && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setFiles(prev => prev.filter(f => f.status !== 'pending'))}
                      className="text-red-600 border-red-300 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear Queue
                    </Button>
                    <Button
                      onClick={scanAndShowPayment}
                      className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                    >
                      <UploadIcon className="w-4 h-4 mr-2" />
                      Process All
                    </Button>
                  </>
                )}
                {scanningPages && (
                  <Button disabled className="bg-gradient-to-r from-green-600 to-emerald-600 opacity-80">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Counting pages...
                  </Button>
                )}
                {uploading && (
                  <Button
                    onClick={stopUpload}
                    disabled={cancelUpload}
                    variant="destructive"
                    className="bg-red-600 hover:bg-red-700"
                  >
                    <StopCircle className="w-4 h-4 mr-2" />
                    {cancelUpload ? 'Stopping...' : 'Stop Upload'}
                  </Button>
                )}
                {allCompleted && (
                  <>
                    <Button
                      variant="outline"
                      onClick={clearCompleted}
                    >
                      Clear Completed
                    </Button>
                    <Button
                      onClick={() => navigate(createPageUrl("Library"))}
                      className="bg-gradient-to-r from-blue-600 to-cyan-600"
                    >
                      View in Library
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {files.map((fileData) => {
              const FileIcon = getFileIcon(fileData.type);
              return (
                <div
                  key={fileData.id}
                  className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200"
                >
                  <div className={`p-2 rounded-lg ${
                    fileData.type.startsWith('image/') ? 'bg-purple-100' :
                    fileData.type.includes('zip') ? 'bg-amber-100' :
                    'bg-blue-100'
                  }`}>
                    <FileIcon className={`w-6 h-6 ${
                      fileData.type.startsWith('image/') ? 'text-purple-600' :
                      fileData.type.includes('zip') ? 'text-amber-600' :
                      'text-blue-600'
                    }`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 truncate">{fileData.name}</p>
                    <div className="flex items-center gap-3 text-sm text-slate-500">
                      <span>{(fileData.size / 1024 / 1024).toFixed(2)} MB</span>
                      <span>•</span>
                      <span className="truncate">{fileData.type || 'Unknown type'}</span>
                    </div>
                    {fileData.status === 'error' && fileData.errorMessage && (
                      <p className="text-xs text-red-600 mt-1 font-medium">
                        Error: {fileData.errorMessage}
                      </p>
                    )}
                    {fileData.status === 'cancelled' && (
                      <p className="text-xs text-orange-600 mt-1 font-medium">
                        {fileData.errorMessage || 'Upload cancelled'}
                      </p>
                    )}
                    {progress[fileData.id] > 0 && fileData.status !== 'completed' && fileData.status !== 'error' && fileData.status !== 'cancelled' && (
                      <Progress value={progress[fileData.id]} className="mt-2" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {fileData.status === 'completed' && (
                          <>
                            {fileData.isDuplicate && (
                              <Checkbox
                                checked={selectedForDeletion.has(fileData.documentId)}
                                onCheckedChange={() => toggleDuplicateSelection(fileData.documentId)}
                              />
                            )}
                            <CheckCircle className="w-5 h-5 text-green-600" />
                            {fileData.isDuplicate && (
                              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">
                                Duplicate
                              </Badge>
                            )}
                            {fileData.hasDuplicatePages && (
                              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-300">
                                Dup Pages
                              </Badge>
                            )}
                            {fileData.documentId && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={async () => {
                                  await base44.entities.Document.delete(fileData.documentId);
                                  queryClient.invalidateQueries({ queryKey: ['documents'] });
                                  setFiles(prev => prev.filter(f => f.id !== fileData.id));
                                }}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            )}
                          </>
                        )}
                    {fileData.status === 'splitting' && (
                      <div className="flex items-center gap-2 text-cyan-700">
                        <Scissors className="w-4 h-4 animate-pulse" />
                        <span className="text-xs font-medium">Auto-splitting…</span>
                      </div>
                    )}
                    {fileData.status === 'error' && (
                      <AlertCircle className="w-5 h-5 text-red-600" />
                    )}
                    {fileData.status === 'cancelled' && (
                      <StopCircle className="w-5 h-5 text-orange-600" />
                    )}
                    {fileData.status === 'pending' && !uploading && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFile(fileData.id)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {documentWithDuplicates && (
        <DuplicatePagesDialog
          document={documentWithDuplicates}
          onClose={() => setDocumentWithDuplicates(null)}
        />
      )}

      <PagePaymentDialog
        open={showPaymentDialog}
        onClose={() => setShowPaymentDialog(false)}
        estimatedPages={estimatedPageCount}
        onProceed={handlePaymentProceed}
      />
    </div>
  );
}