import React, { useMemo, useState } from "react";
import { AlertTriangle, Check, X, ChevronDown, ChevronUp, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function VisitContentPanel({ visit, index, isSelected, onToggle }) {
  const fields = [
    { label: "Provider", value: visit.rendering_provider },
    { label: "Setting", value: visit.practice_setting },
    { label: "Chief Complaint", value: visit.chief_complaint },
    { label: "HPI", value: visit.hpi_summary },
    { label: "Physical Exam", value: visit.physical_exam_findings },
    { label: "Imaging", value: visit.imaging_findings },
    { label: "Impression / Diagnosis", value: visit.impression_diagnosis },
    { label: "Treatment Plan", value: visit.treatment_plan },
    { label: "Pain Scale", value: visit.pain_scale },
  ].filter(f => f.value);

  return (
    <div
      className={`flex-1 min-w-[280px] rounded-lg border-2 overflow-hidden transition-all cursor-pointer ${
        isSelected ? "border-red-400 bg-red-50" : "border-slate-300 bg-white hover:border-slate-400"
      }`}
      onClick={onToggle}
    >
      {/* Header */}
      <div className={`px-3 py-2 flex items-center justify-between gap-2 ${
        isSelected ? "bg-red-200 text-red-800" : "bg-slate-100 text-slate-700"
      }`}>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => {}}
            className="w-4 h-4 cursor-pointer"
            onClick={e => e.stopPropagation()}
          />
          <span className="font-semibold text-sm">Visit {index + 1}</span>
          {visit.rendering_provider && (
            <span className="text-xs opacity-80 truncate max-w-[140px]">{visit.rendering_provider}</span>
          )}
        </div>
        {isSelected && <Badge className="bg-red-600 text-white text-xs">Will delete</Badge>}
      </div>

      {/* Content */}
      <div className="p-3 space-y-2 text-xs text-slate-700 overflow-y-auto" style={{ maxHeight: "380px" }}>
        {fields.length === 0 && (
          <p className="text-slate-400 italic">No content available</p>
        )}
        {fields.map(({ label, value }) => (
          <div key={label}>
            <span className="font-semibold text-slate-900">{label}: </span>
            <span>{value}</span>
          </div>
        ))}
        {visit.icd10_codes?.length > 0 && (
          <div>
            <span className="font-semibold text-slate-900">ICD-10: </span>
            <span>{visit.icd10_codes.join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DuplicateVisitDetector({ visits, onDuplicateAction }) {
  const [selectedForDeletion, setSelectedForDeletion] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});

  const duplicateGroups = useMemo(() => {
    const dateMap = {};
    visits.forEach((visit, i) => {
      if (!visit.visit_date) return;
      if (!dateMap[visit.visit_date]) dateMap[visit.visit_date] = [];
      dateMap[visit.visit_date].push({ index: i, visit });
    });
    return Object.values(dateMap).filter(group => group.length > 1);
  }, [visits]);

  if (duplicateGroups.length === 0) return null;

  const toggleExpand = (groupIdx) => {
    setExpandedGroups(prev => ({ ...prev, [groupIdx]: !prev[groupIdx] }));
  };

  const toggleItem = (groupKey, itemIndex) => {
    const selected = selectedForDeletion[groupKey] || new Set();
    const newSelected = new Set(selected);
    if (newSelected.has(itemIndex)) {
      newSelected.delete(itemIndex);
    } else {
      newSelected.add(itemIndex);
    }
    setSelectedForDeletion(prev => ({
      ...prev,
      [groupKey]: newSelected.size > 0 ? newSelected : undefined
    }));
  };

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-900">
          <AlertTriangle className="w-5 h-5" />
          Same-Day Visits ({duplicateGroups.length} date{duplicateGroups.length > 1 ? "s" : ""})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-amber-800">
          Multiple visits on the same date were found. Click a visit card to select it for deletion, then click "Delete Selected".
        </p>

        {Object.values(selectedForDeletion).some(s => s && s.size > 0) && (
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                const allIndices = Object.values(selectedForDeletion).flatMap(s => s ? Array.from(s) : []);
                setConfirmDelete({ groupIdx: null, indicesToDelete: allIndices, deleteAll: true });
              }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              <X className="w-4 h-4 mr-1" />
              Delete All Selected ({Object.values(selectedForDeletion).reduce((sum, s) => sum + (s ? s.size : 0), 0)})
            </Button>
          </div>
        )}

        {duplicateGroups.map((group, groupIdx) => {
          const groupKey = `group-${groupIdx}`;
          const isExpanded = !!expandedGroups[groupIdx];
          const selectedSet = selectedForDeletion[groupKey] || new Set();
          const hasSelections = selectedSet.size > 0;

          return (
            <div key={groupIdx} className="border border-amber-200 rounded-lg bg-white overflow-hidden">
              {/* Group header - always visible */}
              <div className="flex items-center justify-between px-4 py-3 bg-amber-50 border-b border-amber-200">
                <div className="flex items-center gap-3">
                  <h4 className="font-semibold text-slate-900">
                    {group[0].visit.visit_date
                      ? new Date(group[0].visit.visit_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
                      : `Group ${groupIdx + 1}`}
                  </h4>
                  <Badge variant="outline" className="bg-amber-100 text-amber-800">
                    {group.length} visits
                  </Badge>
                  {hasSelections && (
                    <Badge className="bg-red-100 text-red-700 border-red-200">
                      {selectedSet.size} selected for deletion
                    </Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpand(groupIdx)}
                  className="text-slate-600 hover:text-slate-900 flex items-center gap-1"
                >
                  <Eye className="w-4 h-4" />
                  {isExpanded ? "Hide" : "Compare"}
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              </div>

              {/* Expanded side-by-side content */}
              {isExpanded && (
                <div className="p-4">
                  <p className="text-xs text-slate-500 mb-3">
                    Click a visit card to select/deselect it for deletion:
                  </p>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {group.map((item) => (
                      <VisitContentPanel
                        key={item.index}
                        visit={item.visit}
                        index={item.index}
                        isSelected={selectedSet.has(item.index)}
                        onToggle={() => toggleItem(groupKey, item.index)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-end px-4 py-3 border-t border-amber-100">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedForDeletion(prev => ({ ...prev, [groupKey]: undefined }))}
                  className="text-slate-600 hover:text-slate-700"
                >
                  <Check className="w-4 h-4 mr-1" />
                  Keep All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasSelections}
                  onClick={() => {
                    setConfirmDelete({
                      groupIdx,
                      indicesToDelete: Array.from(selectedSet),
                    });
                  }}
                  className="text-red-600 hover:text-red-700 border-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <X className="w-4 h-4 mr-1" />
                  Delete Selected ({selectedSet.size})
                </Button>
              </div>
            </div>
          );
        })}

        {confirmDelete && (
          <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Selected Visits?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete {confirmDelete.indicesToDelete.length} visit(s) from this summary. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex justify-end gap-3">
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onDuplicateAction("delete-selected", confirmDelete.indicesToDelete);
                    if (confirmDelete.deleteAll) {
                      setSelectedForDeletion({});
                    } else {
                      setSelectedForDeletion(prev => ({
                        ...prev,
                        [`group-${confirmDelete.groupIdx}`]: undefined,
                      }));
                    }
                    setConfirmDelete(null);
                  }}
                  className="bg-red-600 hover:bg-red-700"
                >
                  Delete
                </AlertDialogAction>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </CardContent>
    </Card>
  );
}