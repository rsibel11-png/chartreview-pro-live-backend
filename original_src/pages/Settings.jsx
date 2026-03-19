import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings as SettingsIcon, Save, FileText, Image, Upload, X, Wand2, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import MacrosManager from "@/components/settings/MacrosManager";

export default function Settings() {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [fontFamily, setFontFamily] = useState("Calibri");
  const [fontSize, setFontSize] = useState(11);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [letterheadUrl, setLetterheadUrl] = useState(null);
  const [uploadingLetterhead, setUploadingLetterhead] = useState(false);
  const letterheadInputRef = useRef(null);
  const formatInputRef = useRef(null);
  const [analyzingFormat, setAnalyzingFormat] = useState(false);
  const [formatDetected, setFormatDetected] = useState(null);

  useEffect(() => {
    const fetchUser = async () => {
      const userData = await base44.auth.me();
      setUser(userData);
      setFontFamily(userData.export_font_family || "Calibri");
      setFontSize(userData.export_font_size || 11);
      setLetterheadUrl(userData.letterhead_url || null);
    };
    fetchUser();
  }, []);

  const handleLetterheadUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingLetterhead(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    setLetterheadUrl(file_url);
    setUploadingLetterhead(false);
  };

  const handleFormatUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAnalyzingFormat(true);
    setFormatDetected(null);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const result = await base44.functions.invoke('extractDocFormat', { file_url });
      const detected = result.data;
      const validFonts = ["Calibri", "Arial", "Times New Roman", "Georgia", "Verdana"];
      const validSizes = [9, 10, 11, 12, 13, 14, 16];
      const detectedFont = validFonts.includes(detected.font_family) ? detected.font_family : "Calibri";
      const detectedSize = validSizes.includes(detected.font_size) ? detected.font_size : 11;
      setFontFamily(detectedFont);
      setFontSize(detectedSize);
      setFormatDetected({ font_family: detectedFont, font_size: detectedSize, notes: detected.notes });
    } finally {
      setAnalyzingFormat(false);
      if (formatInputRef.current) formatInputRef.current.value = '';
    }
  };

  const removeLetterhead = () => {
    setLetterheadUrl(null);
    if (letterheadInputRef.current) letterheadInputRef.current.value = '';
  };

  const saveMutation = useMutation({
    mutationFn: (data) => base44.auth.updateMe(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      export_font_family: fontFamily,
      export_font_size: fontSize,
      letterhead_url: letterheadUrl || null,
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-cyan-500 rounded-lg flex items-center justify-center shadow-md">
            <SettingsIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
            <p className="text-slate-600 mt-1">Customize your export preferences</p>
          </div>
        </div>

        {saveSuccess && (
          <Alert className="bg-green-50 border-green-200">
            <AlertDescription className="text-green-900">
              Settings saved successfully!
            </AlertDescription>
          </Alert>
        )}

        <Card className="shadow-lg">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-3">
              <FileText className="w-5 h-5 text-blue-600" />
              <div>
                <CardTitle>Word Export Settings</CardTitle>
                <CardDescription>Set default font style and size for medical summary exports</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {/* Auto-detect from document */}
            <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-semibold text-blue-900">Auto-detect from your document</span>
              </div>
              <p className="text-xs text-slate-600">Upload a PDF or Word document (.doc/.docx) and the app will automatically detect its font and size settings, then apply them to all your future Word exports. PDF files give the most accurate results.</p>
              {formatDetected && (
                <div className="flex items-center gap-2 text-sm text-green-800 bg-green-50 border border-green-200 rounded p-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                  <span>Detected: <strong>{formatDetected.font_family}</strong>, <strong>{formatDetected.font_size}pt</strong>{formatDetected.notes ? ` — ${formatDetected.notes}` : ''}</span>
                </div>
              )}
              <input ref={formatInputRef} type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={handleFormatUpload} id="format-upload" />
              <label htmlFor="format-upload">
                <Button asChild variant="outline" disabled={analyzingFormat} className="cursor-pointer border-blue-300 text-blue-700 hover:bg-blue-100">
                  <span>
                    {analyzingFormat ? (
                      <><span className="animate-spin mr-2">⏳</span>Analyzing document...</>
                    ) : (
                      <><Upload className="w-4 h-4 mr-2" />Upload Template Document</>
                    )}
                  </span>
                </Button>
              </label>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">
                  Font Family
                </label>
                <Select value={fontFamily} onValueChange={setFontFamily}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Calibri">Calibri</SelectItem>
                    <SelectItem value="Arial">Arial</SelectItem>
                    <SelectItem value="Times New Roman">Times New Roman</SelectItem>
                    <SelectItem value="Georgia">Georgia</SelectItem>
                    <SelectItem value="Verdana">Verdana</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  Choose the default font for exported Word documents
                </p>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">
                  Font Size
                </label>
                <Select value={fontSize.toString()} onValueChange={(val) => setFontSize(parseInt(val))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="9">9 pt</SelectItem>
                    <SelectItem value="10">10 pt</SelectItem>
                    <SelectItem value="11">11 pt</SelectItem>
                    <SelectItem value="12">12 pt</SelectItem>
                    <SelectItem value="13">13 pt</SelectItem>
                    <SelectItem value="14">14 pt</SelectItem>
                    <SelectItem value="16">16 pt</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  Set the default font size in points
                </p>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-6">
              <h4 className="text-sm font-semibold text-slate-900 mb-3">Preview</h4>
              <div 
                className="p-4 bg-white border border-slate-200 rounded-lg"
                style={{ fontFamily: fontFamily, fontSize: `${fontSize}pt` }}
              >
                <p>This is how your exported medical summaries will look.</p>
                <p className="mt-2">The quick brown fox jumps over the lazy dog.</p>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-6 space-y-3">
              <div className="flex items-center gap-3">
                <Image className="w-5 h-5 text-blue-600" />
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">Letterhead</h4>
                  <p className="text-xs text-slate-500">Upload an image to use as a full-page background/watermark on exports. You'll be asked whether to apply it each time you export.</p>
                </div>
              </div>

              {letterheadUrl ? (
                <div className="flex items-center gap-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <img src={letterheadUrl} alt="Letterhead preview" className="h-20 object-contain rounded border border-slate-200 bg-white" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700">Letterhead uploaded</p>
                    <p className="text-xs text-slate-500">This will be offered as a background watermark on exports</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={removeLetterhead} className="text-red-600 hover:bg-red-50 flex-shrink-0">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <div>
                  <input ref={letterheadInputRef} type="file" accept="image/*" className="hidden" onChange={handleLetterheadUpload} id="letterhead-upload" />
                  <label htmlFor="letterhead-upload">
                    <Button asChild variant="outline" disabled={uploadingLetterhead} className="cursor-pointer">
                      <span>
                        {uploadingLetterhead ? (
                          <><span className="animate-spin mr-2">⏳</span>Uploading...</>
                        ) : (
                          <><Upload className="w-4 h-4 mr-2" />Upload Letterhead Image</>
                        )}
                      </span>
                    </Button>
                  </label>
                  <p className="text-xs text-slate-500 mt-1">PNG, JPG, or GIF. Recommended: full page size at low opacity.</p>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-4">
              <Button 
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>
        <MacrosManager />
      </div>
    </div>
  );
}