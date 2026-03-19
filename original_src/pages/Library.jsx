import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { 
  FileText, 
  Download, 
  Trash2, 
  Filter,
  Search,
  ExternalLink,
  Calendar,
  User,
  Building,
  Copy,
  Scan,
  Loader2,
  AlertTriangle,
  Folder,
  FolderOpen,
  Edit2,
  Plus,
  MoveRight,
  FolderPlus,
  ArrowLeft,
  ScanSearch,
  RotateCcw
} from "lucide-react";
import { assessDocumentRelevance } from "../components/utils/documentRelevance";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DuplicatePagesDialog from "../components/upload/DuplicatePagesDialog";
import RelevancePagesDialog from "../components/upload/RelevancePagesDialog";

export default function Library() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [subcategoryFilter, setSubcategoryFilter] = useState("all");
  const [viewMode, setViewMode] = useState("date"); // "date" or "folder"
  const [folderFilter, setFolderFilter] = useState("all");
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [deleteAllDialog, setDeleteAllDialog] = useState(false);
  const [viewingDuplicatePages, setViewingDuplicatePages] = useState(null);
  const [viewingRelevancePages, setViewingRelevancePages] = useState(null);
  const [scanningDocument, setScanningDocument] = useState(null);
  const [normalizingExtensions, setNormalizingExtensions] = useState(false);
  const [editingFolder, setEditingFolder] = useState(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedDocuments, setSelectedDocuments] = useState(new Set());
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [moveToFolder, setMoveToFolder] = useState("");
  const [openFolder, setOpenFolder] = useState(null);
  const [deleteFolderDialog, setDeleteFolderDialog] = useState(null);
  const [folderDuplicatesDialog, setFolderDuplicatesDialog] = useState(null); // { folderName, groups }
  const [deletingDuplicates, setDeletingDuplicates] = useState(false);
  const [selectedDuplicateIds, setSelectedDuplicateIds] = useState(new Set());
  const [reassessingDocuments, setReassessingDocuments] = useState(false);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list('-created_date', 1000),
    initialData: [],
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Document.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setDeleteDialog(null);
    },
    onError: (error) => {
      console.error("Error deleting document:", error);
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      // It's safer to get the current list of documents again
      // to ensure we delete the exact documents currently displayed/available
      const currentDocuments = queryClient.getQueryData(['documents']);
      if (currentDocuments) {
        // Execute deletions in parallel if possible, or sequentially if API has rate limits
        await Promise.all(currentDocuments.map(doc => base44.entities.Document.delete(doc.id)));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setDeleteAllDialog(false);
    },
    onError: (error) => {
      console.error("Error deleting all documents:", error);
      // Optionally show a toast notification for error
    }
  });

  const normalizeFileExtensions = async () => {
    setNormalizingExtensions(true);
    try {
      const docsToUpdate = documents.filter(doc => {
        const nameParts = doc.title.split('.');
        if (nameParts.length > 1) {
          const ext = nameParts[nameParts.length - 1];
          return ext !== ext.toLowerCase();
        }
        return false;
      });

      for (const doc of docsToUpdate) {
        const nameParts = doc.title.split('.');
        const ext = nameParts.pop().toLowerCase();
        nameParts.push(ext);
        const normalizedTitle = nameParts.join('.');
        
        await base44.entities.Document.update(doc.id, {
          title: normalizedTitle
        });
      }

      queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (error) {
      console.error("Error normalizing extensions:", error);
    }
    setNormalizingExtensions(false);
  };

  const checkForDuplicatePages = async (document) => {
    setScanningDocument(document.id);
    try {
      const prompt = `Analyze this document and identify if there are any duplicate pages within it.
      Look for:
      1. Pages that appear multiple times (exact duplicates)
      2. Pages with identical or nearly identical content
      3. Pages that seem to be scanned/uploaded multiple times
      
      Return the page numbers that are duplicates and describe their similarity.
      If no duplicates are found, return an empty array.
      
      Be thorough but conservative - only flag clear duplicates.`;

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        file_urls: [document.file_url],
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

      // Update document with scan results
      const updatedDoc = await base44.entities.Document.update(document.id, {
        has_duplicate_pages: result.has_duplicates || false,
        duplicate_pages: result.duplicate_groups || [],
        duplicate_pages_reviewed: false,
      });

      queryClient.invalidateQueries({ queryKey: ['documents'] });

      // Show dialog if duplicates found, otherwise notify user
      if (result.has_duplicates) {
        setViewingDuplicatePages(updatedDoc);
      } else {
        toast.success("No duplicate pages detected in this document", {
          duration: 3000,
        });
      }
    } catch (error) {
      console.error("Error scanning for duplicate pages:", error);
    }
    setScanningDocument(null);
  };

  const updateFolderMutation = useMutation({
    mutationFn: ({ docId, folder }) => base44.entities.Document.update(docId, { folder }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setEditingFolder(null);
      setNewFolderName("");
    },
  });

  const moveDocumentsMutation = useMutation({
    mutationFn: async ({ docIds, folder }) => {
      await Promise.all(docIds.map(id => base44.entities.Document.update(id, { folder })));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setShowMoveDialog(false);
      setSelectedDocuments(new Set());
      setMoveToFolder("");
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderName) => {
      const docsInFolder = documents.filter(doc => doc.folder === folderName);
      await Promise.all(docsInFolder.map(doc => base44.entities.Document.delete(doc.id)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setDeleteFolderDialog(null);
    },
  });

  const scanFolderForDuplicates = (folderName) => {
    const folderDocs = folderName === 'unfiled'
      ? documents.filter(d => !d.folder)
      : documents.filter(d => d.folder === folderName);

    // Group by content_hash first, then by title as fallback
    const hashGroups = {};
    const titleGroups = {};

    folderDocs.forEach(doc => {
      if (doc.content_hash) {
        if (!hashGroups[doc.content_hash]) hashGroups[doc.content_hash] = [];
        hashGroups[doc.content_hash].push(doc);
      }
      const titleKey = doc.title.toLowerCase().trim();
      if (!titleGroups[titleKey]) titleGroups[titleKey] = [];
      titleGroups[titleKey].push(doc);
    });

    // Merge groups: a group is a duplicate set if same hash OR same filename
    const duplicateGroups = [];
    const processedIds = new Set();

    // Process hash groups first (strongest signal)
    Object.values(hashGroups).forEach(group => {
      if (group.length > 1) {
        const ids = group.map(d => d.id);
        if (!ids.every(id => processedIds.has(id))) {
          duplicateGroups.push(group);
          ids.forEach(id => processedIds.add(id));
        }
      }
    });

    // Then process title groups (catching same-name files with different hashes)
    Object.values(titleGroups).forEach(group => {
      if (group.length > 1) {
        const unprocessed = group.filter(d => !processedIds.has(d.id));
        if (unprocessed.length > 1) {
          duplicateGroups.push(group.filter(d => !processedIds.has(d.id) || group.some(g => g.id !== d.id && !processedIds.has(g.id))));
        } else if (unprocessed.length === 1) {
          // Some already grouped by hash, merge remaining into existing group
          const existingGroup = duplicateGroups.find(g => g.some(d => group.map(gd => gd.id).includes(d.id)));
          if (existingGroup) {
            unprocessed.forEach(d => {
              if (!existingGroup.find(g => g.id === d.id)) existingGroup.push(d);
            });
          }
        }
        group.forEach(d => processedIds.add(d.id));
      }
    });

    setFolderDuplicatesDialog({ folderName, groups: duplicateGroups });
    // Pre-select all duplicates (keep first in each group, select rest for deletion)
    const toDelete = new Set();
    duplicateGroups.forEach(group => {
      group.slice(1).forEach(d => toDelete.add(d.id));
    });
    setSelectedDuplicateIds(toDelete);
  };

  const deleteSelectedDuplicates = async () => {
    setDeletingDuplicates(true);
    await Promise.all(Array.from(selectedDuplicateIds).map(id => base44.entities.Document.delete(id)));
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    setDeletingDuplicates(false);
    setFolderDuplicatesDialog(null);
    setSelectedDuplicateIds(new Set());
  };

  const reassessSelectedDocuments = async () => {
    setReassessingDocuments(true);
    const docsToReassess = Array.from(selectedDocuments).map(id => 
      documents.find(d => d.id === id)
    ).filter(Boolean);

    for (const doc of docsToReassess) {
      try {
        const result = await assessDocumentRelevance(doc.file_url);
        
        const isRejected = result.is_relevant_medical_document === false;
        const rejectionReason = result.rejection_reason || 'Not related to actual medical treatment or office visits';

        const updatedDoc = await base44.entities.Document.update(doc.id, {
          category: result.category || 'uncategorized',
          subcategory: result.subcategory,
          patient_name: result.patient_name,
          document_date: result.document_date,
          provider_name: result.provider_name,
          case_number: result.case_number,
          extracted_text: result.extracted_text,
          page_count: result.page_count || doc.page_count,
          is_rejected: isRejected,
          rejection_reason: isRejected ? rejectionReason : '',
          low_relevance_pages: result.low_relevance_pages || [],
          notes: (result.office_visit_count && result.office_visit_count > 1 
            ? `Contains ${result.office_visit_count} office visits. ` 
            : '') + (result.notes || ''),
        });

        // If low-relevance pages detected, show the dialog
        if (result.low_relevance_pages && result.low_relevance_pages.length > 0) {
          setViewingRelevancePages(updatedDoc);
        }
      } catch (error) {
        console.error(`Error reassessing document ${doc.id}:`, error);
      }
    }

    queryClient.invalidateQueries({ queryKey: ['documents'] });
    setReassessingDocuments(false);
    setSelectedDocuments(new Set());
    toast.success(`Re-assessed ${docsToReassess.length} document${docsToReassess.length !== 1 ? 's' : ''}`);
  };

  const toggleDocumentSelection = (docId) => {
    setSelectedDocuments(prev => {
      const newSet = new Set(prev);
      if (newSet.has(docId)) {
        newSet.delete(docId);
      } else {
        newSet.add(docId);
      }
      return newSet;
    });
  };

  const selectAllUnfiled = () => {
    const unfiledDocs = filteredDocuments.filter(doc => !doc.folder);
    setSelectedDocuments(new Set(unfiledDocs.map(d => d.id)));
  };

  const clearSelection = () => {
    setSelectedDocuments(new Set());
  };

  const filteredDocuments = documents.filter(doc => {
    const matchesSearch = doc.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.patient_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.case_number?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.folder?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.rejection_reason?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || doc.category === categoryFilter;
    const matchesSubcategory = subcategoryFilter === 'all' || doc.subcategory === subcategoryFilter;
    const matchesFolder = folderFilter === 'all' || 
                           (folderFilter === 'none' && !doc.folder) ||
                           doc.folder === folderFilter;

    // If a folder is open, only show documents in that folder
    if (openFolder !== null) {
      if (openFolder === 'unfiled') {
        return !doc.folder && matchesSearch && matchesCategory && matchesSubcategory;
      }
      if (openFolder === 'Rejected Documents') {
        return doc.folder === 'Rejected Documents' && matchesSearch && matchesCategory && matchesSubcategory;
      }
      return doc.folder === openFolder && matchesSearch && matchesCategory && matchesSubcategory;
    }

    return matchesSearch && matchesCategory && matchesSubcategory && matchesFolder;
  });

  const subcategories = [...new Set(documents.map(d => d.subcategory).filter(Boolean))];
  const folders = [...new Set(documents.map(d => d.folder).filter(Boolean))].sort();
  
  // Count documents per folder
  const folderCounts = folders.reduce((acc, folder) => {
    acc[folder] = documents.filter(d => d.folder === folder).length;
    return acc;
  }, {});
  const unfiledCount = documents.filter(d => !d.folder && !d.is_rejected).length;
  const rejectedCount = documents.filter(d => d.is_rejected).length;

  // Group documents by folder or date
  const groupedDocuments = viewMode === "folder" 
    ? filteredDocuments.reduce((groups, doc) => {
        const folderName = doc.folder || 'Unfiled';
        if (!groups[folderName]) {
          groups[folderName] = [];
        }
        groups[folderName].push(doc);
        return groups;
      }, {})
    : filteredDocuments.reduce((groups, doc) => {
    const uploadDate = new Date(doc.created_date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    let groupKey;
    if (uploadDate.toDateString() === today.toDateString()) {
      groupKey = 'Today';
    } else if (uploadDate.toDateString() === yesterday.toDateString()) {
      groupKey = 'Yesterday';
    } else if (uploadDate > new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)) {
      groupKey = 'This Week';
    } else if (uploadDate > new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)) {
      groupKey = 'This Month';
    } else {
      groupKey = 'Earlier';
    }
    
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(doc);
    return groups;
  }, {});

  const orderedGroups = viewMode === "folder"
    ? Object.keys(groupedDocuments).sort((a, b) => {
        if (a === 'Unfiled') return 1;
        if (b === 'Unfiled') return -1;
        return a.localeCompare(b);
      })
    : ['Today', 'Yesterday', 'This Week', 'This Month', 'Earlier'].filter(key => groupedDocuments[key]);

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            {openFolder && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpenFolder(null)}
                className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Folders
              </Button>
            )}
            <div>
              <h1 className="text-3xl font-bold text-slate-900">
                {openFolder ? openFolder : 'Document Library'}
              </h1>
              <p className="text-slate-600">
                {openFolder 
                  ? `${filteredDocuments.length} document${filteredDocuments.length !== 1 ? 's' : ''} in this folder`
                  : 'Browse and manage all uploaded documents'
                }
              </p>
            </div>
          </div>
        </div>
        {documents.length > 0 && (
          <div className="flex gap-2">
            {documents.some(d => d.title.split('.').pop() !== d.title.split('.').pop().toLowerCase()) && (
              <Button
                variant="outline"
                onClick={normalizeFileExtensions}
                disabled={normalizingExtensions}
                className="border-blue-600 text-blue-600 hover:bg-blue-50"
              >
                {normalizingExtensions ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Fixing Extensions...
                  </>
                ) : (
                  'Fix .PDF Extensions'
                )}
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={() => setDeleteAllDialog(true)}
              className="bg-red-600 hover:bg-red-700"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All Documents
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <Card className="shadow-md">
        <CardContent className="p-6">
          <div className="space-y-4">
            {/* View Mode Tabs */}
            <div className="flex gap-2 border-b border-slate-200 pb-4">
              <Button
                variant={viewMode === "date" ? "default" : "outline"}
                onClick={() => setViewMode("date")}
                className={viewMode === "date" ? "bg-blue-600" : ""}
              >
                <Calendar className="w-4 h-4 mr-2" />
                By Date
              </Button>
              <Button
                variant={viewMode === "folder" ? "default" : "outline"}
                onClick={() => setViewMode("folder")}
                className={viewMode === "folder" ? "bg-blue-600" : ""}
              >
                <Folder className="w-4 h-4 mr-2" />
                By Folder
              </Button>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="md:col-span-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search documents, patients, case numbers, folders..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="medical">Medical</SelectItem>
                  <SelectItem value="legal">Legal</SelectItem>
                  <SelectItem value="uncategorized">Uncategorized</SelectItem>
                </SelectContent>
              </Select>

              {viewMode === "folder" ? (
                <Select value={folderFilter} onValueChange={setFolderFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Folder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Folders</SelectItem>
                    <SelectItem value="none">Unfiled</SelectItem>
                    {folders.map(folder => (
                      <SelectItem key={folder} value={folder}>
                        {folder}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={subcategoryFilter} onValueChange={setSubcategoryFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {subcategories.map(sub => (
                      <SelectItem key={sub} value={sub}>
                        {sub.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results Count & Selection Actions */}
      {openFolder && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            Showing {filteredDocuments.length} of {documents.length} documents
          </p>
        <div className="flex items-center gap-2">
          {selectedDocuments.size > 0 && (
            <>
              <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                {selectedDocuments.size} selected
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowMoveDialog(true);
                  setMoveToFolder("");
                }}
              >
                <MoveRight className="w-4 h-4 mr-2" />
                Move to Folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={reassessSelectedDocuments}
                disabled={reassessingDocuments}
                className="border-blue-600 text-blue-600 hover:bg-blue-50"
              >
                {reassessingDocuments ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Re-assessing...
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Re-assess ({selectedDocuments.size})
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={clearSelection}
              >
                Clear
              </Button>
            </>
          )}
          {filteredDocuments.filter(d => !d.folder).length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={selectAllUnfiled}
              className="border-blue-600 text-blue-600 hover:bg-blue-50"
            >
              <FolderPlus className="w-4 h-4 mr-2" />
              Select All Unfiled ({filteredDocuments.filter(d => !d.folder).length})
            </Button>
          )}
        </div>
      </div>
      )}

      {/* Folders or Documents Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-32 bg-slate-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !openFolder ? (
        /* Folder View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {folders.map((folder) => (
            <Card 
              key={folder}
              className="hover:shadow-lg transition-all duration-300 group hover:border-blue-400 relative"
            >
              <CardContent className="p-6 cursor-pointer" onClick={() => setOpenFolder(folder)}>
                <div className="flex flex-col items-center text-center space-y-3">
                  <div className="w-20 h-20 bg-gradient-to-br from-blue-100 to-blue-200 rounded-2xl flex items-center justify-center group-hover:from-blue-200 group-hover:to-blue-300 transition-all">
                    <Folder className="w-10 h-10 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900 line-clamp-2">
                      {folder}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">
                      {folderCounts[folder]} document{folderCounts[folder] !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              </CardContent>
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={(e) => { e.stopPropagation(); scanFolderForDuplicates(folder); }}
                  title="Scan for duplicate documents"
                >
                  <ScanSearch className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={(e) => { e.stopPropagation(); setDeleteFolderDialog(folder); }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
          {unfiledCount > 0 && (
            <Card 
              className="hover:shadow-lg transition-all duration-300 cursor-pointer group hover:border-slate-400"
              onClick={() => setOpenFolder('unfiled')}
            >
              <CardContent className="p-6">
                <div className="flex flex-col items-center text-center space-y-3">
                  <div className="w-20 h-20 bg-gradient-to-br from-slate-100 to-slate-200 rounded-2xl flex items-center justify-center group-hover:from-slate-200 group-hover:to-slate-300 transition-all">
                    <Folder className="w-10 h-10 text-slate-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">
                      Unfiled
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">
                      {unfiledCount} document{unfiledCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              </CardContent>
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  onClick={(e) => { e.stopPropagation(); scanFolderForDuplicates('unfiled'); }}
                  title="Scan for duplicate documents"
                >
                  <ScanSearch className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          )}
          {rejectedCount > 0 && (
            <Card 
              className="hover:shadow-lg transition-all duration-300 cursor-pointer group hover:border-red-400 relative"
              onClick={() => setOpenFolder('Rejected Documents')}
            >
              <CardContent className="p-6">
                <div className="flex flex-col items-center text-center space-y-3">
                  <div className="w-20 h-20 bg-gradient-to-br from-red-100 to-orange-100 rounded-2xl flex items-center justify-center group-hover:from-red-200 group-hover:to-orange-200 transition-all">
                    <AlertTriangle className="w-10 h-10 text-red-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">
                      Rejected Documents
                    </h3>
                    <p className="text-sm text-red-600 font-medium mt-1">
                      {rejectedCount} document{rejectedCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              </CardContent>
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={(e) => { e.stopPropagation(); setDeleteFolderDialog('Rejected Documents'); }}
                  title="Delete all rejected documents"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          )}
        </div>
      ) : filteredDocuments.length > 0 ? (
        /* Document View inside folder */
        <div className="space-y-8">
          {orderedGroups.map((groupKey) => (
            <div key={groupKey}>
              <div className="flex items-center gap-3 mb-4">
                {viewMode === "folder" && (
                  groupKey === 'Unfiled' ? (
                    <Folder className="w-5 h-5 text-slate-400" />
                  ) : (
                    <FolderOpen className="w-5 h-5 text-blue-600" />
                  )
                )}
                <h2 className="text-xl font-semibold text-slate-900">{groupKey}</h2>
                {viewMode === "folder" && (
                  <Badge variant="outline" className="ml-2">
                    {groupedDocuments[groupKey].length}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {groupedDocuments[groupKey].map((doc) => (
            <Card key={doc.id} className={`hover:shadow-lg transition-all duration-300 group ${
              selectedDocuments.has(doc.id) ? 'ring-2 ring-blue-500 bg-blue-50' : ''
            }`}>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {/* Icon and Category */}
                  <div className="flex items-start justify-between">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                      doc.category === 'medical' 
                        ? 'bg-cyan-100' 
                        : doc.category === 'legal' 
                        ? 'bg-blue-100' 
                        : 'bg-slate-100'
                    }`}>
                      <FileText className={`w-6 h-6 ${
                        doc.category === 'medical' 
                          ? 'text-cyan-600' 
                          : doc.category === 'legal' 
                          ? 'text-blue-600' 
                          : 'text-slate-600'
                      }`} />
                    </div>
                    <TooltipProvider>
                      <div className="flex gap-2">
                        <Checkbox
                          checked={selectedDocuments.has(doc.id)}
                          onCheckedChange={() => toggleDocumentSelection(doc.id)}
                          className="mt-1"
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a
                              href={doc.file_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50">
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            </a>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Open document</p>
                          </TooltipContent>
                        </Tooltip>
                        {!doc.has_duplicate_pages && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-blue-600 hover:text-blue-700"
                                onClick={() => checkForDuplicatePages(doc)}
                                disabled={scanningDocument === doc.id}
                              >
                                {scanningDocument === doc.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Scan className="w-4 h-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Scan for duplicate pages</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {!doc.is_rejected && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-700 hover:bg-slate-50"
                                onClick={() => {
                                  setEditingFolder(doc);
                                  setNewFolderName(doc.original_folder || "");
                                }}
                              >
                                <Edit2 className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Edit folder</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {doc.is_rejected && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                onClick={() => {
                                  updateFolderMutation.mutate({ 
                                    docId: doc.id, 
                                    folder: doc.original_folder || null 
                                  });
                                }}
                                disabled={updateFolderMutation.isLoading}
                              >
                                <MoveRight className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Restore to original folder</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setDeleteDialog(doc)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Delete document</p>
                        </TooltipContent>
                        </Tooltip>
                      </div>
                    </TooltipProvider>
                  </div>

                  {/* Title */}
                  <div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <h3 className="font-semibold text-slate-900 line-clamp-2 mb-2 cursor-default">
                            {doc.title}
                          </h3>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{doc.title}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className={
                        doc.category === 'medical' 
                          ? 'bg-cyan-50 text-cyan-700 border-cyan-200' 
                          : doc.category === 'legal'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }>
                        {doc.category || 'Uncategorized'}
                      </Badge>
                      {doc.is_duplicate && (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                            Duplicate
                          </Badge>
                        )}
                        {doc.is_rejected && (
                          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                            {doc.rejection_reason || 'Rejected'}
                          </Badge>
                        )}
                        {doc.has_duplicate_pages && (
                          <Badge 
                            variant="outline" 
                            className="bg-orange-50 text-orange-700 border-orange-200 cursor-pointer hover:bg-orange-100"
                            onClick={() => setViewingDuplicatePages(doc)}
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Dup Pages
                          </Badge>
                        )}
                    </div>
                  </div>

                  {/* Metadata */}
                  <div className="space-y-2 text-sm">
                    {doc.folder && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Folder className="w-4 h-4 text-blue-500" />
                        <span className="font-medium">{doc.folder}</span>
                      </div>
                    )}
                    {doc.file_size && (
                      <p className="text-slate-600">
                        Size: <span className="font-medium">{(doc.file_size / 1024 / 1024).toFixed(2)} MB</span>
                      </p>
                    )}
                    {doc.subcategory && (
                      <p className="text-slate-600">
                        Type: <span className="font-medium">{doc.subcategory.replace(/_/g, ' ')}</span>
                      </p>
                    )}
                    {doc.patient_name && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <User className="w-4 h-4" />
                        <span>{doc.patient_name}</span>
                      </div>
                    )}
                    {doc.provider_name && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Building className="w-4 h-4" />
                        <span>{doc.provider_name}</span>
                      </div>
                    )}
                    {doc.document_date && (
                      <div className="flex items-center gap-2 text-slate-600">
                        <Calendar className="w-4 h-4" />
                        <span>{new Date(doc.document_date).toLocaleDateString()}</span>
                      </div>
                    )}
                    {doc.case_number && (
                      <p className="text-slate-600">
                        Case: <span className="font-medium">{doc.case_number}</span>
                      </p>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="pt-4 border-t border-slate-200 text-xs text-slate-500">
                    Uploaded {new Date(doc.created_date).toLocaleDateString()}
                  </div>
                </div>
              </CardContent>
            </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card className="shadow-md">
          <CardContent className="p-12 text-center">
            <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-600 text-lg">No documents found</p>
            <p className="text-slate-500 text-sm mt-2">Try adjusting your filters or search terms</p>
          </CardContent>
        </Card>
      )}

      {/* Delete Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteDialog?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(deleteDialog.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete All Dialog */}
      <AlertDialog open={deleteAllDialog} onOpenChange={setDeleteAllDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <AlertDialogTitle className="text-xl">Delete All Documents</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="space-y-2">
              <p className="font-semibold text-slate-900">
                Are you sure you want to delete ALL {documents.length} documents?
              </p>
              <p>
                This will permanently delete all documents from your library, including:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>{documents.filter(d => d.category === 'medical').length} medical documents</li>
                <li>{documents.filter(d => d.category === 'legal').length} legal documents</li>
                <li>{documents.filter(d => d.category === 'uncategorized').length} uncategorized documents</li>
              </ul>
              <p className="font-semibold text-red-600 mt-3">
                This action cannot be undone!
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAllMutation.mutate()}
              disabled={deleteAllMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteAllMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete All {documents.length} Documents
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Duplicate Pages Dialog */}
      {viewingDuplicatePages && (
        <DuplicatePagesDialog
          document={viewingDuplicatePages}
          onClose={() => {
            setViewingDuplicatePages(null);
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          }}
        />
      )}

      {/* Low Relevance Pages Dialog */}
      {viewingRelevancePages && (
        <RelevancePagesDialog
          document={viewingRelevancePages}
          onClose={() => {
            setViewingRelevancePages(null);
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          }}
        />
      )}

      {/* Edit Folder Dialog */}
      <Dialog open={!!editingFolder} onOpenChange={() => setEditingFolder(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Folder</DialogTitle>
            <DialogDescription>
              Assign this document to a folder for better organization
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 mb-2 block">
                Document: {editingFolder?.title}
              </label>
              <Input
                placeholder="Enter folder name (e.g., Case #12345, John Doe)"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
              />
              {folders.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-slate-500 mb-2">Existing folders:</p>
                  <div className="flex flex-wrap gap-2">
                    {folders.map(folder => (
                      <Button
                        key={folder}
                        variant="outline"
                        size="sm"
                        onClick={() => setNewFolderName(folder)}
                        className="text-xs"
                      >
                        <Folder className="w-3 h-3 mr-1" />
                        {folder}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingFolder(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => updateFolderMutation.mutate({ 
                docId: editingFolder.id, 
                folder: newFolderName || null 
              })}
              disabled={updateFolderMutation.isLoading}
            >
              {updateFolderMutation.isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Folder Dialog */}
      <AlertDialog open={!!deleteFolderDialog} onOpenChange={() => setDeleteFolderDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <AlertDialogTitle className="text-xl">Delete Folder</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="space-y-2">
              <p className="font-semibold text-slate-900">
                Delete folder "{deleteFolderDialog}"?
              </p>
              <p>
                This will permanently delete all {folderCounts[deleteFolderDialog]} document{folderCounts[deleteFolderDialog] !== 1 ? 's' : ''} in this folder.
              </p>
              <p className="font-semibold text-red-600 mt-3">
                This action cannot be undone!
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteFolderMutation.mutate(deleteFolderDialog)}
              disabled={deleteFolderMutation.isLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteFolderMutation.isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Folder
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Folder Duplicate Documents Dialog */}
      <Dialog open={!!folderDuplicatesDialog} onOpenChange={() => setFolderDuplicatesDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Duplicate Documents in "{folderDuplicatesDialog?.folderName}"</DialogTitle>
            <DialogDescription>
              {folderDuplicatesDialog?.groups?.length > 0
                ? `Found ${folderDuplicatesDialog.groups.length} duplicate group${folderDuplicatesDialog.groups.length !== 1 ? 's' : ''}. The first document in each group is kept; duplicates are pre-selected for deletion.`
                : 'No duplicate documents found in this folder.'}
            </DialogDescription>
          </DialogHeader>
          {folderDuplicatesDialog?.groups?.length > 0 ? (
            <div className="space-y-4">
              {folderDuplicatesDialog.groups.map((group, gi) => (
                <div key={gi} className="border rounded-lg overflow-hidden">
                  <div className="bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Duplicate Group {gi + 1} — {group.length} files
                  </div>
                  <div className="divide-y">
                    {group.map((doc, di) => {
                      const isFirst = di === 0;
                      const isSelected = selectedDuplicateIds.has(doc.id);
                      return (
                        <div key={doc.id} className={`flex items-center gap-3 px-4 py-3 ${isFirst ? 'bg-green-50' : ''}`}>
                          {isFirst ? (
                          <div className="w-5 h-5 flex items-center justify-center">
                          <div className="w-3 h-3 rounded-full bg-green-500" title="Kept" />
                          </div>
                          ) : (
                          <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                          setSelectedDuplicateIds(prev => {
                            const next = new Set(prev);
                            if (checked) next.add(doc.id); else next.delete(doc.id);
                            return next;
                          });
                          }}
                          />
                          )}
                          <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{doc.title}</p>
                          <p className="text-xs text-slate-500">
                          {isFirst ? 'Keep (original)' : 'Mark for deletion'} · Uploaded {new Date(doc.created_date).toLocaleDateString()}
                          </p>
                          {doc.is_rejected && (
                          <p className="text-xs text-red-600 mt-1">Rejected: {doc.rejection_reason}</p>
                          )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-slate-500">
              <Copy className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p>No duplicate documents found in this folder.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDuplicatesDialog(null)}>Close</Button>
            {folderDuplicatesDialog?.groups?.length > 0 && selectedDuplicateIds.size > 0 && (
              <Button
                onClick={deleteSelectedDuplicates}
                disabled={deletingDuplicates}
                className="bg-red-600 hover:bg-red-700"
              >
                {deletingDuplicates ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting...</>
                ) : (
                  <><Trash2 className="w-4 h-4 mr-2" />Delete {selectedDuplicateIds.size} Duplicate{selectedDuplicateIds.size !== 1 ? 's' : ''}</>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to Folder Dialog */}
      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Documents to Folder</DialogTitle>
            <DialogDescription>
              Move {selectedDocuments.size} selected document{selectedDocuments.size !== 1 ? 's' : ''} to a folder
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 mb-2 block">
                Folder Name
              </label>
              <Input
                placeholder="Enter new folder name or select existing"
                value={moveToFolder}
                onChange={(e) => setMoveToFolder(e.target.value)}
                autoFocus
              />
              {folders.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-slate-500 mb-2">Or select existing folder:</p>
                  <div className="flex flex-wrap gap-2">
                    {folders.map(folder => (
                      <Button
                        key={folder}
                        variant={moveToFolder === folder ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMoveToFolder(folder)}
                        className={moveToFolder === folder ? "bg-blue-600" : ""}
                      >
                        <Folder className="w-3 h-3 mr-1" />
                        {folder}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMoveDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => moveDocumentsMutation.mutate({ 
                docIds: Array.from(selectedDocuments), 
                folder: moveToFolder || null 
              })}
              disabled={!moveToFolder || moveDocumentsMutation.isLoading}
            >
              {moveDocumentsMutation.isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Moving...
                </>
              ) : (
                <>
                  <MoveRight className="w-4 h-4 mr-2" />
                  Move to Folder
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}