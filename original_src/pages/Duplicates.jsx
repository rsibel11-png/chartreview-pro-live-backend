import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2, ExternalLink, CheckCircle, AlertTriangle, CheckSquare, Square } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

export default function Duplicates() {
  const queryClient = useQueryClient();
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [selectedDuplicates, setSelectedDuplicates] = useState(new Set());
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState(false);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list('-created_date'),
    initialData: [],
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Document.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setDeleteDialog(null);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids) => {
      for (const id of ids) {
        await base44.entities.Document.delete(id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      setSelectedDuplicates(new Set());
      setBulkDeleteDialog(false);
    },
  });

  // Group duplicates
  const duplicateGroups = {};
  documents.forEach(doc => {
    if (doc.is_duplicate && doc.duplicate_of) {
      if (!duplicateGroups[doc.duplicate_of]) {
        const original = documents.find(d => d.id === doc.duplicate_of);
        if (original) {
          duplicateGroups[doc.duplicate_of] = {
            original,
            duplicates: []
          };
        }
      }
      if (duplicateGroups[doc.duplicate_of]) {
        duplicateGroups[doc.duplicate_of].duplicates.push(doc);
      }
    }
  });

  const groupArray = Object.values(duplicateGroups);
  const allDuplicateIds = groupArray.flatMap(group => group.duplicates.map(d => d.id));

  const toggleDuplicateSelection = (id) => {
    setSelectedDuplicates(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const selectAllDuplicates = () => {
    setSelectedDuplicates(new Set(allDuplicateIds));
  };

  const deselectAllDuplicates = () => {
    setSelectedDuplicates(new Set());
  };

  const handleBulkDelete = (keepOriginals = true) => {
    if (keepOriginals) {
      bulkDeleteMutation.mutate(Array.from(selectedDuplicates));
    } else {
      // Delete all documents in groups, keep only one per group
      const idsToDelete = [];
      groupArray.forEach(group => {
        // Keep the original, delete all duplicates
        group.duplicates.forEach(dup => idsToDelete.push(dup.id));
      });
      bulkDeleteMutation.mutate(idsToDelete);
    }
  };

  const allSelected = allDuplicateIds.length > 0 && allDuplicateIds.every(id => selectedDuplicates.has(id));

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-slate-900">Duplicate Manager</h1>
        <p className="text-slate-600">Review and manage duplicate documents</p>
      </div>

      {/* Summary Card */}
      <Card className="bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200 shadow-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-900">
            <AlertTriangle className="w-5 h-5" />
            Duplicate Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-amber-700">Total Duplicates</p>
              <p className="text-3xl font-bold text-amber-900">
                {documents.filter(d => d.is_duplicate).length}
              </p>
            </div>
            <div>
              <p className="text-sm text-amber-700">Duplicate Groups</p>
              <p className="text-3xl font-bold text-amber-900">{groupArray.length}</p>
            </div>
            <div>
              <p className="text-sm text-amber-700">Storage Wasted</p>
              <p className="text-3xl font-bold text-amber-900">
                {(documents.filter(d => d.is_duplicate).reduce((sum, d) => sum + (d.file_size || 0), 0) / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Selection Controls */}
      {allDuplicateIds.length > 0 && (
        <Card className="border-2 border-blue-200 bg-blue-50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={allSelected ? deselectAllDuplicates : selectAllDuplicates}
                  className="bg-white"
                >
                  {allSelected ? <CheckSquare className="w-4 h-4 mr-2" /> : <Square className="w-4 h-4 mr-2" />}
                  {allSelected ? 'Deselect All' : 'Select All Duplicates'}
                </Button>
                {selectedDuplicates.size > 0 && (
                  <Badge variant="secondary" className="bg-blue-600 text-white">
                    {selectedDuplicates.size} selected
                  </Badge>
                )}
              </div>
              {selectedDuplicates.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setBulkDeleteDialog(true)}
                  className="bg-red-600 hover:bg-red-700"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Selected ({selectedDuplicates.size})
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Duplicate Groups */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-32 bg-slate-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : groupArray.length > 0 ? (
        <div className="space-y-6">
          {groupArray.map((group, index) => (
            <Card key={group.original.id} className="shadow-lg">
              <CardHeader className="bg-slate-50 border-b border-slate-200">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Copy className="w-5 h-5 text-amber-600" />
                  Duplicate Group {index + 1}
                  <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200">
                    {group.duplicates.length} duplicate{group.duplicates.length !== 1 ? 's' : ''}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {/* Original Document */}
                  <div className="p-4 bg-green-50 border-2 border-green-200 rounded-lg">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle className="w-5 h-5 text-green-600" />
                          <Badge className="bg-green-600">Original</Badge>
                        </div>
                        <h4 className="font-semibold text-slate-900 mb-2">
                          {group.original.title}
                        </h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-slate-600">
                          <div>
                            <span className="font-medium">Uploaded:</span>{' '}
                            {new Date(group.original.created_date).toLocaleDateString()}
                          </div>
                          <div>
                            <span className="font-medium">Size:</span>{' '}
                            {(group.original.file_size / 1024 / 1024).toFixed(2)} MB
                          </div>
                          <div>
                            <span className="font-medium">Category:</span>{' '}
                            {group.original.category}
                          </div>
                          {group.original.patient_name && (
                            <div>
                              <span className="font-medium">Patient:</span>{' '}
                              {group.original.patient_name}
                            </div>
                          )}
                        </div>
                      </div>
                      <a
                        href={group.original.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button variant="outline" size="sm">
                          <ExternalLink className="w-4 h-4 mr-2" />
                          View
                        </Button>
                      </a>
                    </div>
                  </div>

                  {/* Duplicate Documents */}
                  <div className="space-y-3">
                    {group.duplicates.map((duplicate) => (
                      <div
                        key={duplicate.id}
                        className={`p-4 rounded-lg border-2 transition-all ${
                          selectedDuplicates.has(duplicate.id)
                            ? 'bg-blue-50 border-blue-300'
                            : 'bg-amber-50 border-amber-200'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-start gap-3 flex-1">
                            <Checkbox
                              checked={selectedDuplicates.has(duplicate.id)}
                              onCheckedChange={() => toggleDuplicateSelection(duplicate.id)}
                              className="mt-1"
                            />
                            <div className="flex-1">
                              <h4 className="font-semibold text-slate-900 mb-2">
                                {duplicate.title}
                              </h4>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-slate-600">
                                <div>
                                  <span className="font-medium">Uploaded:</span>{' '}
                                  {new Date(duplicate.created_date).toLocaleDateString()}
                                </div>
                                <div>
                                  <span className="font-medium">Size:</span>{' '}
                                  {(duplicate.file_size / 1024 / 1024).toFixed(2)} MB
                                </div>
                                <div>
                                  <span className="font-medium">Category:</span>{' '}
                                  {duplicate.category}
                                </div>
                                {duplicate.patient_name && (
                                  <div>
                                    <span className="font-medium">Patient:</span>{' '}
                                    {duplicate.patient_name}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <a
                              href={duplicate.file_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button variant="outline" size="sm">
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            </a>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:border-red-300"
                              onClick={() => setDeleteDialog(duplicate)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="shadow-md">
          <CardContent className="p-12 text-center">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <p className="text-slate-900 text-lg font-semibold">No duplicates found!</p>
            <p className="text-slate-500 text-sm mt-2">All your documents are unique.</p>
          </CardContent>
        </Card>
      )}

      {/* Single Delete Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Duplicate</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this duplicate document? The original will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(deleteDialog.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete Duplicate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Dialog */}
      <AlertDialog open={bulkDeleteDialog} onOpenChange={setBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Selected Duplicates</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                You are about to delete {selectedDuplicates.size} duplicate document{selectedDuplicates.size !== 1 ? 's' : ''}. 
              </p>
              <p className="font-semibold text-slate-900">
                What would you like to keep?
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-col gap-2">
            <AlertDialogAction
              onClick={() => handleBulkDelete(true)}
              disabled={bulkDeleteMutation.isLoading}
              className="bg-green-600 hover:bg-green-700 w-full"
            >
              {bulkDeleteMutation.isLoading ? 'Deleting...' : 'Keep Originals & Delete Selected Duplicates'}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => handleBulkDelete(false)}
              disabled={bulkDeleteMutation.isLoading}
              className="bg-blue-600 hover:bg-blue-700 w-full"
            >
              {bulkDeleteMutation.isLoading ? 'Deleting...' : 'Keep Only One Deduplicated Document Per Group'}
            </AlertDialogAction>
            <AlertDialogCancel className="w-full">Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}