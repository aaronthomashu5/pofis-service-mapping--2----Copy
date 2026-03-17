
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Machine, InspectionReport, ServiceThresholds } from '../types';
import { machineService } from '../services/machineService';
import { useActiveMachines, useThresholds, useSaveInspection, useSaveMaterialRequest, useUpdateMachineStatus, queryKeys } from '../hooks/useQueries';
import { ClipboardListIcon } from './icons/ClipboardListIcon';
import { CubeIcon } from './icons/CubeIcon';
import { WrenchIcon } from './icons/WrenchIcon';
import { FlagIcon } from './icons/FlagIcon';
import { InspectionForm, ServiceReportPrompt } from './ServiceWorkflowModals';
import { useEmailSettings } from '../hooks/useQueries';
import { handleDownloadInspectionReport, handleDownloadServiceReport, handleSendServiceReportEmail } from '../lib/reportActions';
import type { QueueFilter } from '../App';

type SortOption = 'client' | 'date' | 'brand' | 'lot' | 'status' | 'workflow';

interface Props { 
    onRequestParts?: (ctx: any) => void;
    filter?: QueueFilter;
} 

const ServiceQueueView: React.FC<Props> = ({ onRequestParts, filter = 'active' }) => {
    const [sortBy, setSortBy] = useState<SortOption>('date');
    const [now, setNow] = useState(Date.now());
    const [page, setPage] = useState(1);

    // Reset to page 1 whenever the filter changes
    useEffect(() => { setPage(1); }, [filter]);
    const pageSize = 50;

    // Modal State
    const [inspectingMachineId, setInspectingMachineId] = useState<string | null>(null);
    const [completedMachine, setCompletedMachine] = useState<Machine | null>(null);

    // Reorder mode state
    const [reorderMode, setReorderMode] = useState(false);
    const [localOrder, setLocalOrder] = useState<Machine[]>([]);
    const [isSavingOrder, setIsSavingOrder] = useState(false);
    const [userRole, setUserRole] = useState<'admin' | 'user'>('user');
    const dragIndexRef = useRef<number | null>(null);
    const queryClient = useQueryClient();

    useEffect(() => {
        machineService.getUserProfile().then(p => setUserRole(p.role));
    }, []);

    // React Query hooks - cached and optimized with pagination
    const { data: emailSettings } = useEmailSettings();
    const { data: thresholds = { inspectionHours: 3, materialRequestHours: 24, serviceHours: 4 } } = useThresholds();

    const effectiveFetchActiveOnly = !['all', 'status-completed'].includes(filter);

    // Resolve which status values to fetch from DB — push status filters server-side
    const dbStatusFilter: string[] | undefined = (() => {
        if (filter === 'all') return undefined;
        if (filter === 'status-completed') return ['Completed'];
        if (filter === 'status-inspection') return ['Pending Inspection', 'Inspected'];
        if (filter === 'status-parts') return ['Parts Requested'];
        if (filter === 'status-service') return ['Under Service'];
        // 'active', 'flagged', time-* filters: fetch all non-completed and client-filter
        return undefined;
    })();

    const { data, isLoading: machinesLoading } = useActiveMachines(false, page, pageSize, dbStatusFilter);
    let machines = data?.machines || [];
    
    // Client-side filters that can't be pushed to DB (flagged, time ranges)
    if (filter === 'flagged') {
        machines = machines.filter(m => {
            if (!m.lastStatusUpdate || m.serviceStatus === 'Completed') return false;
            const workingHours = machineService.getWorkingMinutes(m.lastStatusUpdate, now) / 60;
            let limit = 0;
            if (m.serviceStatus === 'Pending Inspection') limit = thresholds.inspectionHours;
            else if (m.serviceStatus === 'Parts Requested') limit = thresholds.materialRequestHours;
            else if (m.serviceStatus === 'Under Service') limit = thresholds.serviceHours;
            return limit > 0 && workingHours > limit;
        });
    } else if (filter.startsWith('time-')) {
        machines = machines.filter(m => {
            if (!m.lastStatusUpdate || m.serviceStatus === 'Completed') return false;
            const h = machineService.getWorkingMinutes(m.lastStatusUpdate, now) / 60;
            if (filter === 'time-1h') return h < 1;
            if (filter === 'time-4h') return h >= 1 && h < 4;
            if (filter === 'time-24h') return h >= 4 && h < 24;
            if (filter === 'time-over24h') return h >= 24;
            return false;
        });
    }

    const totalMachines = data?.total || 0;
    const hasMore = data?.hasMore || false;
    const totalPages = Math.ceil(totalMachines / pageSize);

    // Mutations
    const saveInspection = useSaveInspection();
    const saveMaterialRequest = useSaveMaterialRequest();
    const updateStatus = useUpdateMachineStatus();

    const isLoading = machinesLoading;

    // Refresh timer for "elapsed time" display
    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 60000); // Update every minute
        return () => clearInterval(interval);
    }, []);

    // --- ACTIONS ---

    const handleInspectSubmit = async (data: Omit<InspectionReport, 'timestamp'>) => {
        if (!inspectingMachineId) return;
        await saveInspection.mutateAsync({ machineId: inspectingMachineId, report: data });
        setInspectingMachineId(null);
    };

    const handleStartService = async (machineId: string) => {
        const technician = window.prompt("Enter technician name taking up the job:");
        if (technician && technician.trim() !== '') {
            await updateStatus.mutateAsync({ machineId, status: 'Under Service', note: `Technician assigned: ${technician.trim()}` });
        }
    };

    const handleCompleteService = async (machine: Machine) => {
        if (confirm("Mark this service as Completed?")) {
            await updateStatus.mutateAsync({ machineId: machine.id, status: 'Completed', note: 'Service marked as complete' });
            setCompletedMachine({ ...machine, serviceStatus: 'Completed' });
        }
    };

    // --- SORTING ---

    const getTimestampFromBatch = (batchId?: string) => {
        if (!batchId || !batchId.startsWith('BATCH-')) return 0;
        return parseInt(batchId.split('-')[1], 10) || 0;
    };

    const sortedMachines = useMemo(() => {
        const sorted = [...machines];
        switch (sortBy) {
            case 'client':
                return sorted.sort((a, b) => a.client.localeCompare(b.client));
            case 'brand':
                return sorted.sort((a, b) => {
                    const makeCompare = a.make.localeCompare(b.make);
                    return makeCompare !== 0 ? makeCompare : a.model.localeCompare(b.model);
                });
            case 'status':
                return sorted.sort((a, b) => (a.serviceStatus || '').localeCompare(b.serviceStatus || ''));
            case 'lot': 
                return sorted.sort((a, b) => (a.batchId || '').localeCompare(b.batchId || ''));
            case 'workflow':
                return sorted.sort((a, b) => (a.priorityIndex || 0) - (b.priorityIndex || 0));
            case 'date': 
            default:
                return sorted.sort((a, b) => getTimestampFromBatch(b.batchId) - getTimestampFromBatch(a.batchId));
        }
    }, [machines, sortBy]);

    // --- REORDER HANDLERS ---

    // Keep localOrder in sync when not actively reordering
    useEffect(() => {
        if (!reorderMode) setLocalOrder(sortedMachines);
    }, [reorderMode]); // eslint-disable-line react-hooks/exhaustive-deps
    // Also update whenever fresh data arrives (not in reorder mode)
    useEffect(() => {
        if (!reorderMode) setLocalOrder(sortedMachines);
    }, [sortedMachines]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleEnterReorder = () => {
        setSortBy('workflow');
        setLocalOrder([...sortedMachines].sort((a, b) => (a.priorityIndex || 0) - (b.priorityIndex || 0)));
        setReorderMode(true);
    };

    const handleDragStart = (index: number) => {
        dragIndexRef.current = index;
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        const from = dragIndexRef.current;
        if (from === null || from === index) return;
        const next = [...localOrder];
        const [moved] = next.splice(from, 1);
        next.splice(index, 0, moved);
        setLocalOrder(next);
        dragIndexRef.current = index;
    };

    const handleMoveUp = (index: number) => {
        if (index === 0) return;
        const next = [...localOrder];
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
        setLocalOrder(next);
    };

    const handleMoveDown = (index: number) => {
        if (index === localOrder.length - 1) return;
        const next = [...localOrder];
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
        setLocalOrder(next);
    };

    const handleSaveOrder = async () => {
        setIsSavingOrder(true);
        try {
            const baseIndex = (page - 1) * pageSize;
            const updates = localOrder.map((m, i) => ({ id: m.id, priority: baseIndex + i }));
            await machineService.updateWorkflowOrder(updates);
            queryClient.invalidateQueries({ queryKey: queryKeys.activeMachines });
            setReorderMode(false);
        } finally {
            setIsSavingOrder(false);
        }
    };

    const handleCancelReorder = () => {
        setLocalOrder([...sortedMachines].sort((a, b) => (a.priorityIndex || 0) - (b.priorityIndex || 0)));
        setReorderMode(false);
    };

    const displayMachines = reorderMode ? localOrder : sortedMachines;

    // --- RENDER HELPERS ---

    const getStatusColor = (status?: string) => {
        switch (status) {
            case 'Pending Inspection': return 'bg-yellow-50 text-yellow-800 border-yellow-200';
            case 'Inspected': return 'bg-blue-50 text-blue-800 border-blue-200';
            case 'Parts Requested': return 'bg-purple-50 text-purple-800 border-purple-200';
            case 'Under Service': return 'bg-orange-50 text-orange-800 border-orange-200';
            case 'Completed': return 'bg-green-50 text-green-800 border-green-200';
            default: return 'bg-gray-100 text-gray-700 border-gray-200';
        }
    };

    const getFlag = (machine: Machine) => {
        if (!machine.lastStatusUpdate || machine.serviceStatus === 'Completed') return null;

        const workingMins = machineService.getWorkingMinutes(machine.lastStatusUpdate, now);
        const workingHours = workingMins / 60;
        let limit = 0;
        let showFlag = false;

        if (machine.serviceStatus === 'Pending Inspection') limit = thresholds.inspectionHours;
        else if (machine.serviceStatus === 'Parts Requested') limit = thresholds.materialRequestHours;
        else if (machine.serviceStatus === 'Under Service') limit = thresholds.serviceHours;
        // else limit remains 0, no flag for other states like 'Inspected' waiting for action? 
        // User asked for "service queue", "material requisition". 

        if (limit > 0 && workingHours > limit) {
            showFlag = true;
        }

        if (showFlag) {
            return (
                <div className="absolute top-4 right-4 text-red-600 animate-pulse bg-red-50 p-2 rounded-full border border-red-200 shadow-lg group">
                    <FlagIcon />
                    <div className="absolute right-0 top-full mt-2 w-48 bg-white text-red-800 text-xs p-2 rounded border border-red-200 opacity-0 group-hover:opacity-100 transition pointer-events-none z-10 shadow-xl">
                        Exceeded Time Limit of {limit}h for current stage.
                    </div>
                </div>
            );
        }
        return null;
    };

    if (isLoading) {
        return (
            <div className="flex justify-center items-center h-64">
                <div className="w-8 h-8 border-4 border-black border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in pb-20">
            {/* Header stats */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-lg shadow-xl border border-gray-200">
                <div>
                    <h2 className="text-2xl font-bold text-black">Service Queue</h2>
                    <p className="text-gray-500 mt-1">
                        Total Machines: <span className="text-gray-900 font-bold text-lg">{totalMachines}</span>
                        {totalPages > 1 && <span className="text-sm ml-2">(Page {page} of {totalPages})</span>}
                    </p>
                </div>
                
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 flex-wrap">
                    {!reorderMode && (
                        <>
                            <span className="text-sm text-gray-500 uppercase font-bold tracking-wider">Sort By:</span>
                            <div className="flex flex-wrap gap-2">
                                {[
                                    { id: 'date', label: 'Intake Date' },
                                    { id: 'client', label: 'Client' },
                                    { id: 'brand', label: 'Brand' },
                                    { id: 'lot', label: 'Lot' },
                                    { id: 'status', label: 'Status' },
                                    { id: 'workflow', label: 'Workflow Order' }
                                ].map((opt) => (
                                    <button
                                        key={opt.id}
                                        onClick={() => setSortBy(opt.id as SortOption)}
                                        className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                            sortBy === opt.id 
                                            ? 'bg-black text-white shadow-lg shadow-gray-400/50' 
                                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    {userRole === 'admin' && !reorderMode && (
                        <button
                            onClick={handleEnterReorder}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors ml-2"
                            title="Drag cards or use arrows to reprioritise"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                            Reorder Priority
                        </button>
                    )}
                    {reorderMode && (
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded-full">
                                ✦ Drag cards or use ↑↓ to reorder
                            </span>
                            <button
                                onClick={handleSaveOrder}
                                disabled={isSavingOrder}
                                className="px-4 py-1.5 rounded-full text-sm font-bold bg-green-600 text-white hover:bg-green-500 disabled:bg-gray-400 transition-colors"
                            >
                                {isSavingOrder ? 'Saving…' : 'Save Order'}
                            </button>
                            <button
                                onClick={handleCancelReorder}
                                disabled={isSavingOrder}
                                className="px-4 py-1.5 rounded-full text-sm font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="grid grid-cols-1 gap-4">
                {displayMachines.map((machine, listIndex) => {
                    const status = machine.serviceStatus || 'Pending Inspection';
                    const workingDuration = machine.lastStatusUpdate 
                        ? machineService.getWorkingDurationFormatted(machine.lastStatusUpdate, now)
                        : '0h 0m';
                    const serialNo = (page - 1) * pageSize + listIndex + 1;

                    return (
                        <div
                            key={machine.id}
                            draggable={reorderMode}
                            onDragStart={reorderMode ? () => handleDragStart(listIndex) : undefined}
                            onDragOver={reorderMode ? (e) => handleDragOver(e, listIndex) : undefined}
                            onDragEnd={reorderMode ? () => { dragIndexRef.current = null; } : undefined}
                            className={`relative bg-white p-4 rounded-lg shadow-lg border transition flex flex-col gap-4 ${
                                reorderMode
                                    ? 'border-indigo-300 cursor-grab active:cursor-grabbing hover:border-indigo-400 hover:shadow-xl'
                                    : 'border-gray-200 hover:border-gray-300'
                            }`}
                        >
                            {/* Serial Number Badge */}
                            <div className="absolute top-3 left-3 w-7 h-7 rounded-full bg-gray-800 text-white text-xs font-bold flex items-center justify-center shadow z-10">
                                {serialNo}
                            </div>

                            {getFlag(machine)}

                            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
                                {/* Drag handle + up/down icons (reorder mode) */}
                                {reorderMode && (
                                    <div className="flex-shrink-0 flex flex-col items-center gap-1 pr-1">
                                        <span className="text-gray-400 select-none text-lg leading-none">⠿</span>
                                        <button
                                            onClick={() => handleMoveUp(listIndex)}
                                            disabled={listIndex === 0}
                                            className="w-7 h-7 flex items-center justify-center rounded bg-gray-100 hover:bg-indigo-100 disabled:opacity-30 disabled:cursor-not-allowed transition text-gray-600 hover:text-indigo-700"
                                        >
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 15l7-7 7 7" /></svg>
                                        </button>
                                        <button
                                            onClick={() => handleMoveDown(listIndex)}
                                            disabled={listIndex === displayMachines.length - 1}
                                            className="w-7 h-7 flex items-center justify-center rounded bg-gray-100 hover:bg-indigo-100 disabled:opacity-30 disabled:cursor-not-allowed transition text-gray-600 hover:text-indigo-700"
                                        >
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
                                        </button>
                                    </div>
                                )}

                                {/* Icon / Image */}
                                <div className="flex-shrink-0 w-16 h-16 bg-gray-100 rounded-md flex items-center justify-center overflow-hidden border border-gray-200 ml-6">
                                    {machine.photo ? (
                                        <img src={machine.photo} alt="Machine" className="w-full h-full object-cover" />
                                    ) : (
                                        <span className="text-2xl">🚜</span>
                                    )}
                                </div>

                                {/* Main Info */}
                                <div className="flex-grow grid grid-cols-2 md:grid-cols-4 gap-4 w-full">
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase font-bold">Machine</p>
                                        <p className="text-gray-900 font-semibold">{machine.make} {machine.model}</p>
                                        <p className="text-xs text-gray-500">{machine.serialNumber || 'No S/N'}</p>
                                    </div>
                                    
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase font-bold">Client</p>
                                        <p className="text-gray-700">{machine.client}</p>
                                    </div>

                                    <div>
                                        <p className="text-xs text-gray-500 uppercase font-bold">Status</p>
                                        <div className={`inline-block px-2 py-1 rounded text-xs mt-1 border ${getStatusColor(status)} font-medium`}>
                                            {status}
                                        </div>
                                        <p className="text-xs text-gray-500 mt-1">In State: {workingDuration}</p>
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="flex flex-col gap-2 justify-center pr-8 md:pr-0">
                                        {status === 'Pending Inspection' && (
                                            <button 
                                                onClick={() => setInspectingMachineId(machine.id)}
                                                className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 px-3 rounded transition"
                                            >
                                                <ClipboardListIcon /> Inspect
                                            </button>
                                        )}
                                        {status === 'Inspected' && (
                                            <div className="flex flex-col gap-2">
                                                <button
                                                    onClick={() => onRequestParts && onRequestParts({ machineId: machine.id, model: machine.model, make: machine.make, partNumber: machine.partNumber, serialNumber: machine.serialNumber })}
                                                    className="flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold py-2 px-3 rounded transition"
                                                >
                                                    <CubeIcon /> Request Part
                                                </button>
                                                <button
                                                    onClick={() => handleStartService(machine.id)}
                                                    className="flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-400 text-white text-xs font-bold py-2 px-3 rounded transition"
                                                >
                                                    <WrenchIcon /> Start Service
                                                </button>
                                            </div>
                                        )}
                                        {status === 'Parts Requested' && (
                                            <div className="flex flex-col gap-2">
                                                <button
                                                    onClick={() => onRequestParts && onRequestParts({ machineId: machine.id, model: machine.model, make: machine.make, partNumber: machine.partNumber, serialNumber: machine.serialNumber })}
                                                    className="flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold py-2 px-3 rounded transition"
                                                >
                                                    <CubeIcon /> Add Parts
                                                </button>
                                                <button
                                                    onClick={() => handleStartService(machine.id)}
                                                    className="flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-400 text-white text-xs font-bold py-2 px-3 rounded transition"
                                                >
                                                    <WrenchIcon /> Start Service
                                                </button>
                                            </div>
                                        )}
                                        {status === 'Under Service' && (
                                            <div className="flex flex-col gap-2">
                                                <div className="text-xs text-orange-600 text-center animate-pulse font-bold border border-orange-200 bg-orange-50 p-2 rounded">
                                                    Technician Working...
                                                </div>
                                                <button
                                                    onClick={() => handleCompleteService(machine)}
                                                    className="flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white text-xs font-bold py-2 px-3 rounded transition"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg> Complete
                                                </button>
                                            </div>
                                        )}
                                        {status === 'Completed' && (
                                            <div className="flex flex-col gap-2">
                                                <button 
                                                    onClick={() => handleDownloadServiceReport(machine)}
                                                    className="flex items-center justify-center gap-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold py-1 px-2 rounded border border-gray-300 transition"
                                                >
                                                    📄 PDF Report
                                                </button>
                                                <button 
                                                    onClick={() => handleSendServiceReportEmail(machine, emailSettings)}
                                                    className="flex items-center justify-center gap-1 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold py-1 px-2 rounded border border-blue-200 transition"
                                                >
                                                    ✉️ Email Report
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Expanded Context Details based on Status */}
                            {machine.inspectionReport && (status !== 'Pending Inspection') && (
                                <div className="mt-2 pt-2 border-t border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm bg-gray-50 p-3 rounded">
                                    <div>
                                        <span className="text-gray-500 font-bold text-xs uppercase block">Initial Observation</span>
                                        <p className="text-gray-700">{machine.inspectionReport.observations}</p>
                                    </div>
                                    <div>
                                         <span className="text-gray-500 font-bold text-xs uppercase block">Status</span>
                                         <span className={machine.inspectionReport.isAlive === 'Alive' ? 'text-green-600' : 'text-red-600'}>{machine.inspectionReport.isAlive}</span>
                                         {machine.inspectionReport.errorCodes && <span className="text-gray-500 ml-2">({machine.inspectionReport.errorCodes})</span>}
                                    </div>
                                </div>
                            )}

                            {machine.materialRequest && (status === 'Parts Requested' || status === 'Under Service') && (
                                <div className="mt-2 pt-2 border-t border-gray-200 text-sm bg-yellow-50 p-3 rounded border-l-4 border-yellow-400">
                                     <div className="flex items-center justify-between mb-1">
                                         <span className="text-yellow-800 font-bold text-xs uppercase flex items-center gap-1"><CubeIcon /> Material Request Active</span>
                                         <button
                                             onClick={() => handleDownloadInspectionReport(machine)}
                                             className="flex items-center gap-1 bg-white hover:bg-gray-50 text-gray-700 text-xs font-bold py-1 px-2 rounded border border-gray-300 transition"
                                         >
                                             <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                             Inspection Report
                                         </button>
                                     </div>
                                     <p className="text-gray-700 whitespace-pre-wrap">{machine.materialRequest.parts}</p>
                                </div>
                            )}

                        </div>
                    );
                })}
                
                {displayMachines.length === 0 && (
                    <div className="text-center py-12 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                        No machines currently in the queue.
                    </div>
                )}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
                <div className="flex justify-center items-center gap-4 bg-white p-4 rounded-lg shadow-lg border border-gray-200">
                    <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className={`px-4 py-2 rounded font-medium transition ${
                            page === 1 
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                            : 'bg-black text-white hover:bg-gray-800'
                        }`}
                    >
                        Previous
                    </button>
                    
                    <div className="flex items-center gap-2">
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                            let pageNum;
                            if (totalPages <= 5) {
                                pageNum = i + 1;
                            } else if (page <= 3) {
                                pageNum = i + 1;
                            } else if (page >= totalPages - 2) {
                                pageNum = totalPages - 4 + i;
                            } else {
                                pageNum = page - 2 + i;
                            }
                            
                            return (
                                <button
                                    key={pageNum}
                                    onClick={() => setPage(pageNum)}
                                    className={`w-10 h-10 rounded font-medium transition ${
                                        page === pageNum 
                                        ? 'bg-black text-white' 
                                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                    }`}
                                >
                                    {pageNum}
                                </button>
                            );
                        })}
                    </div>
                    
                    <button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={!hasMore}
                        className={`px-4 py-2 rounded font-medium transition ${
                            !hasMore 
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                            : 'bg-black text-white hover:bg-gray-800'
                        }`}
                    >
                        Next
                    </button>
                    
                    <span className="text-sm text-gray-500 ml-4">
                        Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalMachines)} of {totalMachines}
                    </span>
                </div>
            )}

            {/* Modals */}
            {inspectingMachineId && (
                <InspectionForm 
                    onClose={() => setInspectingMachineId(null)} 
                    onSubmit={handleInspectSubmit} 
                />
            )}

            {completedMachine && (
                <ServiceReportPrompt
                    machineMake={completedMachine.make}
                    machineModel={completedMachine.model}
                    onDownload={() => {
                        handleDownloadServiceReport(completedMachine);
                        setCompletedMachine(null);
                    }}
                    onEmail={() => {
                        handleSendServiceReportEmail(completedMachine, emailSettings);
                        setCompletedMachine(null);
                    }}
                    onClose={() => setCompletedMachine(null)}
                />
            )}
        </div>
    );
};

export default ServiceQueueView;
