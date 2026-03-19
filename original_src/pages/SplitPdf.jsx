import React, { useState, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useUploadManager } from "@/components/UploadManager";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Upload, FileText, Download, Scissors, CheckCircle, AlertCircle, Loader2, ArrowUpCircle } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";

export default function SplitPdf() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | uploading | splitting | done | error
  const [progress, setProgress] = useState(0);
  const [parts, setParts] = useState([]);
  const [error, setError] = useState(null);
  const [sentToUpload, setSentToUpload] = useState(false);
  const inputRef = useRef(null);
  const { addFiles, setSelectedFolder } = useUploadManager();
  const navigate = useNavigate();

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file && file.type === "application/pdf") {
      setSelectedFile(file);
      setParts([]);
      setError(null);
      setStatus("idle");
    } else {
      setError("Please select a PDF file.");
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === "application/pdf") {
      setSelectedFile(file);
      setParts([]);
      setError(null);
      setStatus("idle");
    }
  };

  const handleSplit = async () => {
    if (!selectedFile) return;
    setError(null);
    setParts([]);

    try {
      setStatus("uploading");
      setProgress(20);

      const { file_url } = await base44.integrations.Core.UploadFile({ file: selectedFile });
      setProgress(50);

      setStatus("splitting");
      const response = await base44.functions.invoke("splitPdf", {
        file_url,
        original_filename: selectedFile.name,
      });

      setProgress(100);

      if (response.data?.success) {
        setParts(response.data.parts);
        setStatus("done");
      } else {
        throw new Error(response.data?.error || "Split failed");
      }
    } catch (err) {
      setError(err.message || "An error occurred");
      setStatus("error");
    }
  };

  const downloadPart = async (part) => {
    const a = document.createElement("a");
    a.href = part.file_url;
    a.download = part.filename;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleSendToUpload = async () => {
    // Fetch each part as a File object and add to upload queue
    const fileObjects = await Promise.all(
      parts.map(async (part) => {
        const res = await fetch(part.file_url);
        const blob = await res.blob();
        return new File([blob], part.filename, { type: "application/pdf" });
      })
    );
    addFiles(fileObjects);
    setSentToUpload(true);
    navigate(createPageUrl("Upload"));
  };

  const formatSize = (bytes) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="p-6 md:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Split Large PDF</h1>
        <p className="text-slate-500 mt-1">Break a large PDF into parts under 10 MB for easy uploading</p>
      </div>

      {/* Drop Zone */}
      <Card
        className={`border-2 border-dashed transition-colors cursor-pointer ${
          selectedFile ? "border-blue-300 bg-blue-50" : "border-slate-300 hover:border-blue-400"
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        <CardContent className="p-10 text-center">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          {selectedFile ? (
            <div className="space-y-2">
              <FileText className="w-12 h-12 text-blue-500 mx-auto" />
              <p className="font-semibold text-slate-900">{selectedFile.name}</p>
              <p className="text-sm text-slate-500">{formatSize(selectedFile.size)}</p>
              <p className="text-xs text-slate-400">Click to choose a different file</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Upload className="w-12 h-12 text-slate-400 mx-auto" />
              <p className="text-slate-600 font-medium">Drop your PDF here or click to browse</p>
              <p className="text-sm text-slate-400">PDF files only</p>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {(status === "uploading" || status === "splitting") && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
              <span className="text-slate-700 font-medium">
                {status === "uploading" ? "Uploading PDF..." : "Splitting into parts..."}
              </span>
            </div>
            <Progress value={progress} />
          </CardContent>
        </Card>
      )}

      {selectedFile && status === "idle" && (
        <Button
          onClick={handleSplit}
          className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
          size="lg"
        >
          <Scissors className="w-5 h-5 mr-2" />
          Split PDF into Parts Under 10 MB
        </Button>
      )}

      {status === "done" && parts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700">
              <CheckCircle className="w-5 h-5" />
              Split Complete — {parts.length} Parts Ready
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {parts.map((part) => (
              <div
                key={part.part}
                className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 font-bold text-sm">
                    {part.part}
                  </div>
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{part.filename}</p>
                    <p className="text-xs text-slate-500">
                      Pages {part.page_start}–{part.page_end} · {part.page_count} pages · {formatSize(part.size_bytes)}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => downloadPart(part)}>
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </Button>
              </div>
            ))}

            <div className="flex gap-3 mt-4">
              <Button
                className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
                onClick={handleSendToUpload}
              >
                <ArrowUpCircle className="w-4 h-4 mr-2" />
                Send All Parts to Upload
              </Button>
            </div>

            <Button
              variant="outline"
              className="w-full"
              onClick={() => { setSelectedFile(null); setStatus("idle"); setParts([]); setSentToUpload(false); }}
            >
              Split Another File
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}