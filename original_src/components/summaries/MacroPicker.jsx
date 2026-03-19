import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Save, Trash2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * MacroPicker - shown inline next to a text area
 * Props:
 *   section: "header" | "footer" | "pre_note" | "any"
 *   currentText: string  (the textarea's current value)
 *   onInsert: (text) => void  — replaces textarea content
 */
export default function MacroPicker({ section = "any", currentText, onInsert }) {
  const queryClient = useQueryClient();
  const [saveName, setSaveName] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: macros = [] } = useQuery({
    queryKey: ["macros"],
    queryFn: () => base44.entities.NotesMacro.list(),
    initialData: [],
  });

  const filteredMacros = macros.filter(
    (m) => m.section === "any" || m.section === section
  );

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.NotesMacro.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["macros"] });
      setShowSaveDialog(false);
      setSaveName("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.NotesMacro.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["macros"] }),
  });

  const handleSaveAsMacro = () => {
    if (!saveName.trim() || !currentText?.trim()) return;
    createMutation.mutate({ name: saveName.trim(), content: currentText, section });
  };

  return (
    <>
      <div className="flex items-center gap-2 mt-1">
        {/* Insert macro */}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs h-7 px-2 gap-1">
              <BookOpen className="w-3 h-3" />
              Insert Macro
              <ChevronDown className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            {filteredMacros.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-3">
                No macros saved yet. Type some text and save it as a macro.
              </p>
            ) : (
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {filteredMacros.map((macro) => (
                  <div
                    key={macro.id}
                    className="flex items-center justify-between gap-2 p-2 rounded hover:bg-slate-50 group"
                  >
                    <button
                      className="flex-1 text-left text-sm text-slate-800 font-medium truncate"
                      onClick={() => { onInsert(macro.content); setOpen(false); }}
                    >
                      {macro.name}
                      <span className="block text-xs text-slate-400 font-normal truncate">
                        {macro.content.substring(0, 60)}{macro.content.length > 60 ? '…' : ''}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-red-500 hover:bg-red-50 flex-shrink-0"
                      onClick={() => deleteMutation.mutate(macro.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {/* Save current as macro */}
        <Button
          variant="outline"
          size="sm"
          className="text-xs h-7 px-2 gap-1"
          disabled={!currentText?.trim()}
          onClick={() => setShowSaveDialog(true)}
        >
          <Save className="w-3 h-3" />
          Save as Macro
        </Button>
      </div>

      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save as Macro</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <Input
              placeholder="Macro name (e.g. Personal Injury Intro)"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveAsMacro()}
              autoFocus
            />
            <div className="p-2 bg-slate-50 rounded text-xs text-slate-600 max-h-24 overflow-y-auto whitespace-pre-wrap">
              {currentText}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowSaveDialog(false)}>Cancel</Button>
              <Button
                onClick={handleSaveAsMacro}
                disabled={!saveName.trim() || createMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}