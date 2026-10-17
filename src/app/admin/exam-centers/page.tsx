'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import LoadingButton from '@/components/ui/LoadingButton';

interface ExamCenter {
  id: number;
  name: string;
  enabled: number;
  sort_order: number;
  created_at?: string;
}

export default function AdminExamCenters() {
  const [centers, setCenters] = useState<ExamCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ExamCenter | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');
  const messageTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showMessage = (msg: string, type: 'success' | 'error' = 'success') => {
    clearTimeout(messageTimer.current);
    setMessage(msg);
    setMessageType(type);
    messageTimer.current = setTimeout(() => setMessage(''), 4000);
  };

  const loadCenters = useCallback(() => {
    fetch('/api/admin/exam-centers')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to fetch exam centers');
        return r.json();
      })
      .then((data: ExamCenter[]) => setCenters(data))
      .catch((err) => {
        console.error('[AdminExamCenters] load error:', err?.message || err);
        showMessage('Failed to load exam centers. Check connection.', 'error');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadCenters();
    return () => clearTimeout(messageTimer.current);
  }, [loadCenters]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/exam-centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add exam center');
      setNewName('');
      showMessage('Exam center added');
      loadCenters();
    } catch (err: any) {
      showMessage(err?.message || 'Failed to add exam center', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (id: number) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/exam-centers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update exam center');
      setEditId(null);
      setEditName('');
      showMessage('Exam center updated');
      loadCenters();
    } catch (err: any) {
      showMessage(err?.message || 'Failed to update exam center', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (center: ExamCenter) => {
    if (busyId) return;
    setBusyId(center.id);
    try {
      const res = await fetch(`/api/admin/exam-centers/${center.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: Number(center.enabled) === 1 ? 0 : 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update exam center');
      showMessage(Number(center.enabled) === 1 ? 'Exam center hidden from booking' : 'Exam center enabled');
      loadCenters();
    } catch (err: any) {
      showMessage(err?.message || 'Failed to update exam center', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/admin/exam-centers/${deleting.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete exam center');
      showMessage('Exam center deleted');
      setDeleting(null);
      loadCenters();
    } catch (err: any) {
      showMessage(err?.message || 'Failed to delete exam center', 'error');
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1e3a5f]">Exam Centers</h1>
        <p className="text-gray-500 text-sm mt-1">
          Manage the exam centers customers can choose from during booking. Hidden centers are not shown to customers.
        </p>
      </div>

      {message && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm font-medium ${
            messageType === 'success'
              ? 'bg-green-50 text-green-700 border border-green-100'
              : 'bg-red-50 text-red-700 border border-red-100'
          }`}
        >
          {message}
        </div>
      )}

      <form onSubmit={handleCreate} className="glass-card p-6 mb-6">
        <label className="block text-sm font-semibold text-gray-700 mb-2">
          Add New Exam Center
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="input-field flex-1"
            placeholder="e.g. G. Pulla Reddy Engineering College"
            maxLength={160}
            required
          />
          <LoadingButton type="submit" loading={submitting} loadingText="Adding..." variant="primary">
            Add Center
          </LoadingButton>
        </div>
      </form>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-4 border-[#1e3a5f] border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-gray-500 mt-4">Loading exam centers...</p>
          </div>
        ) : centers.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            No exam centers yet. Add the first one above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-4 text-sm font-semibold text-gray-700">Exam Center</th>
                  <th className="text-center p-4 text-sm font-semibold text-gray-700">Status</th>
                  <th className="text-right p-4 text-sm font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {centers.map((c) => (
                  <tr key={c.id} className="border-t border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="p-4">
                      {editId === c.id ? (
                        <form onSubmit={(e) => { e.preventDefault(); handleUpdate(c.id); }}>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="input-field"
                            maxLength={160}
                            autoFocus
                          />
                        </form>
                      ) : (
                        <span className="font-medium text-gray-900">{c.name}</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      {Number(c.enabled) === 1 ? (
                        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-600">Active</span>
                      ) : (
                        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">Hidden</span>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex justify-end gap-2">
                        {editId === c.id ? (
                          <>
                            <LoadingButton
                              onClick={() => handleUpdate(c.id)}
                              loading={submitting}
                              loadingText="Saving..."
                              variant="ghost"
                              className="bg-green-50 text-green-600 hover:bg-green-100"
                            >
                              Save
                            </LoadingButton>
                            <button
                              onClick={() => { setEditId(null); setEditName(''); }}
                              className="px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-100 transition-colors"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { setEditId(c.id); setEditName(c.name); }}
                              className="px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100 transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleToggle(c)}
                              disabled={busyId === c.id}
                              className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {busyId === c.id ? '…' : Number(c.enabled) === 1 ? 'Hide' : 'Enable'}
                            </button>
                            <button
                              onClick={() => setDeleting(c)}
                              className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-gray-900">Delete Exam Center?</h3>
                <p className="text-sm text-gray-600 mt-1">
                  This removes &quot;{deleting.name}&quot; from the booking options. Existing bookings that reference it are not affected.
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleting(null)}
                disabled={deleteBusy}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <LoadingButton
                onClick={handleDelete}
                loading={deleteBusy}
                loadingText="Deleting..."
                variant="primary"
                className="!bg-red-600 hover:!bg-red-700 px-4 py-2"
              >
                Delete
              </LoadingButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
