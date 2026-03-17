import React, { useState, useEffect } from 'react';
import { machineService } from '../services/machineService';
import { pdfGenerator } from '../services/pdfGenerator';
import type { PartCatalogEntry, Machine } from '../types';

interface SparePartsContext {
    machineId: string;
    model: string;
    make?: string;
    partNumber?: string;
    serialNumber?: string;
}

interface Props {
    context: SparePartsContext | null;
    onBack: () => void;
}

export const SparePartsChecklistView: React.FC<Props> = ({ context, onBack }) => {
    const [availableParts, setAvailableParts] = useState<PartCatalogEntry[]>([]);
    const [selectedParts, setSelectedParts] = useState<string[]>([]);
    const [notes, setNotes] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [submittedMachine, setSubmittedMachine] = useState<Machine | null>(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        if (context?.model) {
            loadParts(context.model, context.make);
        }
    }, [context]);

    const loadParts = async (model: string, make?: string) => {
        setLoading(true);
        try {
            const data = await machineService.getPartsForMachine(model, make);
            setAvailableParts(data || []);
        } catch (error) {
            console.error('Failed to load parts:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleTogglePart = (partNumber: string) => {
        setSelectedParts(prev => 
            prev.includes(partNumber) 
                ? prev.filter(p => p !== partNumber)
                : [...prev, partNumber]
        );
    };

    const handleSubmit = async () => {
        if (!context?.machineId) return;
        setSubmitting(true);
        try {
            const requestedItems = selectedParts.map(pn => {
                const part = availableParts.find(p => p.partNumber === pn);
                return part ? `${part.partName} (${part.partNumber})` : pn;
            });
            const requestString = `Requested Parts:\n${requestedItems.join('\n')}\n\nNotes:\n${notes}`;
            
            await machineService.saveMaterialRequest(context.machineId, requestString);
            await machineService.updateStatus(context.machineId, 'Parts Requested', 'Requested specific parts.');

            const machine = await machineService.getMachineById(context.machineId);
            setSubmittedMachine(machine);
            setSubmitted(true);
        } catch (error) {
            console.error('Failed to submit parts request:', error);
            alert('Failed to submit request.');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDownloadReport = async () => {
        if (!submittedMachine) return;
        setDownloading(true);
        try {
            const doc = await pdfGenerator.generatePartsRequestReportDoc(submittedMachine);
            doc.save(`InspectionReport-${submittedMachine.serialNumber || submittedMachine.id}-${Date.now()}.pdf`);
        } catch (error) {
            console.error('Failed to generate report:', error);
            alert('Failed to generate PDF report.');
        } finally {
            setDownloading(false);
        }
    };

    if (!context) {
        return (
            <div className="p-6 max-w-7xl mx-auto text-center">
                <p className="mb-4 text-gray-600">Go to Service Queue to select a machine for parts.</p>
                <button onClick={onBack} className="bg-blue-600 text-white px-4 py-2 rounded shadow hover:bg-blue-700">Go Back</button>
            </div>
        );
    }

    if (submitted) {
        return (
            <div className="p-6 max-w-7xl mx-auto">
                <div className="mb-6 flex justify-between items-center">
                    <h1 className="text-2xl font-bold text-gray-800">Parts Request</h1>
                    <button onClick={onBack} className="text-gray-600 hover:text-gray-900 font-medium">← Back to Workflow</button>
                </div>
                <div className="bg-white rounded-lg shadow p-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                        <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-semibold text-gray-800">Parts Request Submitted</h2>
                    <p className="text-gray-500">The machine status has been updated to <span className="font-medium text-blue-600">Parts Requested</span>.</p>
                    <div className="flex justify-center gap-4 pt-2">
                        <button
                            onClick={handleDownloadReport}
                            disabled={downloading || !submittedMachine}
                            className="bg-blue-600 text-white px-6 py-2 rounded shadow hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {downloading ? 'Generating...' : 'Download Inspection Report'}
                        </button>
                        <button onClick={onBack} className="bg-gray-100 text-gray-700 px-6 py-2 rounded shadow hover:bg-gray-200">
                            Go Back
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const filteredParts = availableParts.filter(p => 
        p.partNumber.toLowerCase().includes(searchTerm.toLowerCase()) || 
        p.partName.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="p-6 max-w-7xl mx-auto">
            <div className="mb-6 flex justify-between items-center">
                <h1 className="text-2xl font-bold text-gray-800">Parts Request</h1>
                <button onClick={onBack} className="text-gray-600 hover:text-gray-900 font-medium">← Back</button>
            </div>

            <div className="bg-white p-4 rounded-lg shadow mb-6 space-y-2 text-sm">
                <h2 className="font-semibold text-gray-700 mb-2 border-b pb-2">Machine Info</h2>
                <div className="grid grid-cols-2 gap-4">
                    <div><span className="text-gray-500">Make:</span> {context.make || '-'}</div>
                    <div><span className="text-gray-500">Model:</span> {context.model}</div>
                    <div><span className="text-gray-500">S/N:</span> {context.serialNumber || '-'}</div>
                    <div><span className="text-gray-500">P/N:</span> {context.partNumber || '-'}</div>
                </div>
            </div>

            <div className="mb-4">
                <input 
                    type="text" 
                    placeholder="Search parts by name or number..." 
                    className="w-full p-2 border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
                {loading ? (
                    <div className="p-4 text-center text-gray-500">Loading parts...</div>
                ) : (
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 w-10"></th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Part Number</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Part Name</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {filteredParts.map((part) => (
                                <tr key={part.partNumber} className="hover:bg-gray-50 cursor-pointer" onClick={() => handleTogglePart(part.partNumber)}>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <input 
                                            type="checkbox" 
                                            checked={selectedParts.includes(part.partNumber)}
                                            onChange={() => handleTogglePart(part.partNumber)}
                                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                                            onClick={e => e.stopPropagation()}
                                        />
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{part.partNumber}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{part.partName}</td>
                                </tr>
                            ))}
                            {filteredParts.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="px-6 py-4 text-center text-sm text-gray-500">No parts found matching your criteria.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="bg-white p-4 rounded-lg shadow mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
                <textarea 
                    className="w-full p-2 border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500"
                    rows={4}
                    placeholder="Add any additional notes for this material request..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                />
            </div>

            <div className="flex justify-end">
                <button 
                    onClick={handleSubmit} 
                    disabled={submitting || selectedParts.length === 0}
                    className="bg-blue-600 text-white px-6 py-2 rounded shadow hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                    {submitting ? 'Submitting...' : 'Submit Parts Request'}
                </button>
            </div>
        </div>
    );
};
