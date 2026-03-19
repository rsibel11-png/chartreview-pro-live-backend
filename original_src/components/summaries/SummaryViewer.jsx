
import React from "react";
import { Download, Edit, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function SummaryViewer({ summary, onClose, onEdit, onExport }) {
  const formatDiagnoses = (diagnosisText) => {
    if (!diagnosisText) return null;

    const text = diagnosisText.trim();
    const hasMultiple = text.match(/^\d+[\.\)]/m) || text.includes('\n');

    if (hasMultiple) {
      const diagnoses = text.split(/(?:\r?\n)+|\d+[\.\)]\s*/).filter(d => d.trim());
      return diagnoses.filter(d => d.trim());
    }

    return [text];
  };

  // Sort visits chronologically from earliest to latest
  const sortedVisits = summary.visits ? [...summary.visits].sort((a, b) => {
    if (!a.visit_date) return 1;
    if (!b.visit_date) return -1;
    return new Date(a.visit_date) - new Date(b.visit_date);
  }) : [];

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-2xl">Medical Summary</DialogTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Edit className="w-4 h-4 mr-2" />
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={onExport}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Header Info */}
          <div className="bg-slate-50 p-4 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-slate-600 font-medium">Patient</p>
                <p className="text-lg font-semibold text-slate-900">
                  {summary.patient_name || 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600 font-medium">Case Number</p>
                <p className="text-lg font-semibold text-slate-900">
                  {summary.case_number || 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600 font-medium">Total Visits</p>
                <p className="text-lg font-semibold text-slate-900">
                  {summary.visits?.length || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600 font-medium">Status</p>
                <Badge variant="outline" className={
                  summary.status === 'finalized'
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : summary.status === 'reviewed'
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-slate-50 text-slate-700 border-slate-200'
                }>
                  {summary.status}
                </Badge>
              </div>
            </div>
          </div>

          <Separator />

          {/* Display each visit in chronological order - narrative format */}
          <div className="space-y-6" style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '11pt' }}>
            {sortedVisits.map((visit, index) => {
              const visitDate = visit.visit_date
                ? new Date(visit.visit_date)
                : null;
              const formattedDate = visitDate 
                ? `${visitDate.getMonth() + 1}/${visitDate.getDate()}/${visitDate.getFullYear()}`
                : null;

              const diagnoses = formatDiagnoses(visit.impression_diagnosis);
              const hasMultipleDiagnoses = diagnoses && diagnoses.length > 1;

              return (
                <div key={index} className="space-y-2">
                  {/* Main content table */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 0, marginTop: index === 0 ? 0 : '18pt' }}>
                    <tbody>
                      <tr>
                        {/* Date cell - fixed width */}
                        <td style={{ width: '120px', verticalAlign: 'top', paddingRight: 0 }}>
                          {formattedDate && (
                            <strong>{formattedDate}:</strong>
                          )}
                        </td>

                        {/* Content cell - flexible width, left-aligned */}
                        <td style={{ verticalAlign: 'top', textAlign: 'left' }}>
                          <div className="text-slate-800 leading-relaxed">
                            {visit.practice_setting && (
                              <>{visit.practice_setting}. </>
                            )}

                            {visit.rendering_provider && (
                              <>{visit.rendering_provider}. </>
                            )}

                            {visit.hpi_summary && (
                              <>
                                <strong>HPI:</strong> {visit.hpi_summary}{' '}
                                {visit.injury_date && (
                                  <>Injury Date: {new Date(visit.injury_date).toLocaleDateString()}. </>
                                )}
                                {visit.pain_scale && (
                                  <>Pain Scale: {visit.pain_scale}. </>
                                )}
                                {visit.symptom_progression && visit.symptom_progression !== 'not_documented' && (
                                  <>Symptom Progression: {visit.symptom_progression.charAt(0).toUpperCase() + visit.symptom_progression.slice(1)}. </>
                                )}
                              </>
                            )}

                            {visit.physical_exam_findings && (
                              <>
                                <strong>Physical Examination:</strong> {visit.physical_exam_findings}{' '}
                              </>
                            )}

                            {visit.imaging_findings && (
                              <>
                                <strong>Imaging Findings:</strong> {visit.imaging_findings}{' '}
                              </>
                            )}

                            {visit.lab_findings && visit.lab_findings.trim().length > 0 && (
                              <>
                                <strong>Laboratory Findings:</strong> {visit.lab_findings}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Diagnosis as separate paragraph with same alignment */}
                  {visit.impression_diagnosis && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 0, marginTop: '6pt' }}>
                      <tbody>
                        <tr>
                          <td style={{ width: '120px' }}></td>
                          <td style={{ verticalAlign: 'top', textAlign: 'left' }}>
                            <div className="text-slate-800 leading-relaxed">
                              <strong>Diagnosis:</strong>{' '}
                              {hasMultipleDiagnoses ? (
                                <ol className="list-decimal ml-5 mt-1" style={{ margin: 0, paddingLeft: '20px' }}>
                                  {diagnoses.map((diagnosis, idx) => (
                                    <li key={idx} style={{ marginBottom: '3pt' }}>{diagnosis}</li>
                                  ))}
                                </ol>
                              ) : (
                                <span>{diagnoses[0]}</span>
                              )}
                              {visit.icd10_codes && visit.icd10_codes.length > 0 && (
                                <span> (ICD-10: {visit.icd10_codes.join(', ')})</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}

                  {/* Treatment Plan as separate paragraph with same alignment */}
                  {visit.treatment_plan && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '18pt', marginTop: '6pt' }}>
                      <tbody>
                        <tr>
                          <td style={{ width: '120px' }}></td>
                          <td style={{ verticalAlign: 'top', textAlign: 'left' }}>
                            <div className="text-slate-800 leading-relaxed">
                              <strong>Treatment Plan:</strong> {visit.treatment_plan}
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}

            {(!summary.visits || summary.visits.length === 0) && (
              <div className="text-center py-8 text-slate-500">
                No visit data available
              </div>
            )}
          </div>

          <Separator />

          {/* Footer */}
          <div className="text-xs text-slate-500 text-center">
            Generated on {new Date(summary.created_date).toLocaleDateString()} •
            Last updated {new Date(summary.updated_date).toLocaleDateString()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
