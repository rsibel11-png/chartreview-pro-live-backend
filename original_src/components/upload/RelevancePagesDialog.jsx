import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, Trash2, RotateCcw } from "lucide-react";

export default function RelevancePagesDialog({ document, onClose }) {
  const queryClient = useQueryClient();
  const [selectedPages, setSelectedPages] = useState(new Set());
  const [expandedPages, setExpandedPages] = useState(new Set());
  const [isLoading, setIsLoading] = useState(false);

  const pages = document.low_relevance_pages || [];

  const removePagesMutation = useMutation({
    mutationFn: async (pageNumbers) => {
      if (pageNumbers.length === 0) return;

      const result = await base44.functions.invoke('removePdfPages', {
        fileUrl: document.file_url,
        pagesToRemove: pageNumbers,
      });

      if (!result.data.success) {
        throw new Error(result.data.error || 'Failed to remove pages');
      }

      // Update document with new file URL and remove the low relevance pages marker
      await base44.entities.Document.update(document.id, {
        file_url: result.data.new_file_url,
        low_relevance_pages: pages.filter(p => !pageNumbers.includes(p.page_number)),
        page_count: (document.page_count || 1) - pageNumbers.length,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success(`Removed ${selectedPages.size} page${selectedPages.size !== 1 ? 's' : ''}`);
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to remove pages');
    },
  });

  const togglePageSelection = (pageNumber) => {
    setSelectedPages(prev => {
      const next = new Set(prev);
      if (next.has(pageNumber)) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedPages(new Set(pages.map(p => p.page_number)));
  };

  const clearSelection = () => {
    setSelectedPages(new Set());
  };

  const togglePageExpanded = (pageNumber) => {
    setExpandedPages(prev => {
      const next = new Set(prev);
      if (next.has(pageNumber)) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }
      return next;
    });
  };

  const handleRemove = async () => {
    if (selectedPages.size === 0) {
      toast.error('Please select at least one page to remove');
      return;
    }
    removePagesMutation.mutate(Array.from(selectedPages));
  };

  const restorePages = async () => {
    // Mark low_relevance_pages as empty to indicate they were reviewed and kept
    await base44.entities.Document.update(document.id, {
      low_relevance_pages: [],
    });
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    toast.success('Pages restored - no changes made to document');
    onClose();
  };

  return (
    <Dialog open={!!document} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Low Relevance Pages Detected</DialogTitle>
          <DialogDescription>
            These pages appear to have low clinical relevance. Select the ones you want to remove from the document.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {pages.length > 0 ? (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-900">Found {pages.length} low-relevance page{pages.length !== 1 ? 's' : ''}</p>
                    <p className="text-sm text-amber-700 mt-1">
                      These pages may be forms, cover sheets, or other non-clinical content. You can safely remove them.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {pages.map((pageInfo) => (
                  <div
                    key={pageInfo.page_number}
                    className="flex items-start gap-3 p-4 border rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    <Checkbox
                      checked={selectedPages.has(pageInfo.page_number)}
                      onCheckedChange={() => togglePageSelection(pageInfo.page_number)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="font-medium text-slate-900">Page {pageInfo.page_number}</p>
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                          Low Relevance
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 mb-3">
                        {pageInfo.reason}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => togglePageExpanded(pageInfo.page_number)}
                        className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 text-xs"
                      >
                        {expandedPages.has(pageInfo.page_number) ? 'Hide Preview' : 'Show Preview'}
                      </Button>
                      {expandedPages.has(pageInfo.page_number) && (
                        <div className="mt-3 border rounded-lg p-3 bg-slate-50">
                          <iframe
                            src={`${document.file_url}#page=${pageInfo.page_number}`}
                            className="w-full h-64 border rounded"
                            title={`Page ${pageInfo.page_number}`}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={selectAll}
                >
                  Select All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearSelection}
                >
                  Clear
                </Button>
              </div>
            </>
          ) : (
            <div className="py-8 text-center text-slate-500">
              <p>No low-relevance pages detected in this document.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {pages.length > 0 && (
            <>
              <Button
                variant="outline"
                onClick={restorePages}
                className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Keep All Pages
              </Button>
              {selectedPages.size > 0 && (
                <Button
                  onClick={handleRemove}
                  disabled={removePagesMutation.isPending}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {removePagesMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Removing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4 mr-2" />
                      Remove {selectedPages.size} Page{selectedPages.size !== 1 ? 's' : ''}
                    </>
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}