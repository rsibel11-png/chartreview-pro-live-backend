import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const SECTION_LABELS = {
  any: { label: "Any", color: "bg-slate-100 text-slate-700" },
  header: { label: "Header", color: "bg-blue-100 text-blue-700" },
  footer: { label: "Footer", color: "bg-purple-100 text-purple-700" },
  pre_note: { label: "Pre-Visit Note", color: "bg-amber-100 text-amber-700" },
};

export default function MacrosManager() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [section, setSection] = useState("any");

  const { data: macros = [] } = useQuery({
    queryKey: ["macros"],
    queryFn: () => base44.entities.NotesMacro.list(),
    initialData: [],
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.NotesMacro.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["macros"] });
      setName(""); setContent(""); setSection("any"); setShowForm(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.NotesMacro.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["macros"] }),
  });

  return (
    <Card className="shadow-lg">
      <CardHeader className="border-b border-slate-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-blue-600" />
            <div>
              <CardTitle>Note Macros</CardTitle>
              <CardDescription>Saved text templates you can insert into header, footer, and per-visit notes with one click</CardDescription>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowForm(v => !v)} variant="outline">
            <Plus className="w-4 h-4 mr-1.5" />
            New Macro
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        {showForm && (
          <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                placeholder="Macro name (e.g. Personal Injury Intro)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any section</SelectItem>
                  <SelectItem value="header">Header Note</SelectItem>
                  <SelectItem value="footer">Footer Note</SelectItem>
                  <SelectItem value="pre_note">Pre-Visit Note</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea
              placeholder="Macro content..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button
                size="sm"
                disabled={!name.trim() || !content.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate({ name: name.trim(), content, section })}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Save Macro
              </Button>
            </div>
          </div>
        )}

        {macros.length === 0 && !showForm && (
          <p className="text-sm text-slate-500 text-center py-6">
            No macros yet. Click "New Macro" to create your first template.
          </p>
        )}

        <div className="space-y-2">
          {macros.map((macro) => {
            const sectionMeta = SECTION_LABELS[macro.section] || SECTION_LABELS.any;
            return (
              <div key={macro.id} className="flex items-start justify-between gap-3 p-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm text-slate-900">{macro.name}</span>
                    <Badge className={`text-xs px-1.5 py-0 ${sectionMeta.color}`}>{sectionMeta.label}</Badge>
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-2 whitespace-pre-wrap">{macro.content}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 text-red-500 hover:bg-red-50"
                  onClick={() => deleteMutation.mutate(macro.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}