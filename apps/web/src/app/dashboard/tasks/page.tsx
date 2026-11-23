'use client';

import { useEffect, useState } from 'react';
import { useSdk } from '@/lib/sdk-provider';
import { useToast } from '@/lib/toast';
import { useSearchParams } from 'next/navigation';
import { mapTaskActionError } from '@/lib/admin-errors';

type TaskStatus = 'draft' | 'open' | 'bidding' | 'awarded' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled';

interface TaskView {
  id: string;
  title: string;
  description: string;
  requiredSkills: string[];
  budget: number;
  status: TaskStatus;
  assignee: string | null;
  version: number;
  parentId: string | null;
  deadline: number | null;
  progress: number;
  completedAt: number | null;
  biddingDeadline: number | null;
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

interface TaskListResult {
  tasks: TaskView[];
  total: number;
  limit: number | null;
  offset: number;
}

interface BidView {
  bidId: string;
  taskId: string;
  agentId: string;
  price: number;
  eta: number | null;
  approach: string | null;
  confidence: number | null;
  createdAt: number;
}

interface BidListResult {
  taskId: string;
  bids: BidView[];
  total: number;
}

interface AwardResult {
  task: TaskView;
  version: number;
  seq: number;
  awardeeId: string;
  strategy: 'manual' | 'auto';
  exploration: boolean;
}

interface TaskMutationResult {
  task: TaskView;
  version: number;
  seq: number;
}

const STATUS_BADGE: Record<TaskStatus, string> = {
  draft: 'badge-draft',
  open: 'badge-open',
  bidding: 'badge-bidding',
  awarded: 'badge-awarded',
  in_progress: 'badge-in_progress',
  review: 'badge-review',
  done: 'badge-done',
  failed: 'badge-failed',
  cancelled: 'badge-cancelled',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  open: '公开',
  bidding: '竞标中',
  awarded: '已授标',
  in_progress: '执行中',
  review: '审核中',
  done: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

const formatTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString() : '—';

const formatPercent = (p: number) => `${Math.round(p)}%`;

export default function TasksPage() {
  const { client } = useSdk();
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>(
    (searchParams.get('status') as TaskStatus) || ''
  );
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const [selectedTask, setSelectedTask] = useState<TaskView | null>(null);
  const [bids, setBids] = useState<BidView[]>([]);
  const [showDetail, setShowDetail] = useState(false);

  // Forms state
  const [publishForm, setPublishForm] = useState({
    title: '',
    description: '',
    skills: '',
    budget: 0,
    deadline: '',
    biddingDeadline: '',
    parentId: '',
  });
  const [publishing, setPublishing] = useState(false);

  const [bidForm, setBidForm] = useState({
    taskId: '',
    price: 0,
    eta: '',
    approach: '',
    confidence: 0.5,
  });
  const [bidding, setBidding] = useState(false);

  const [actionTaskId, setActionTaskId] = useState('');
  const [actionExpectedVersion, setActionExpectedVersion] = useState(0);
  const [actionNote, setActionNote] = useState('');
  const [actionArtifacts, setActionArtifacts] = useState('');
  const [actionProgress, setActionProgress] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<'approve' | 'reject' | 'request-revision'>('approve');
  const [reviewComment, setReviewComment] = useState('');
  const [reassignTarget, setReassignTarget] = useState('');
  const [reassignReason, setReassignReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [executingAction, setExecutingAction] = useState<string | null>(null);

  useEffect(() => {
    loadTasks();
  }, [client, statusFilter, offset]);

  const loadTasks = async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.listTasks({
        ...(statusFilter ? { status: statusFilter } : {}),
        limit,
        offset,
      });
      setTasks(result.tasks);
      setTotal(result.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载任务失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleViewTask = async (task: TaskView) => {
    if (!client) return;
    setSelectedTask(task);
    setShowDetail(true);
    setActionTaskId(task.id);
    setActionExpectedVersion(task.version);
    try {
      const bidResult = await client.bids({ taskId: task.id });
      setBids(bidResult.bids);
    } catch {
      setBids([]);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || publishing) return;
    setPublishing(true);
    try {
      const result = await client.publishTask({
        title: publishForm.title.trim(),
        description: publishForm.description.trim() || undefined,
        requiredSkills: publishForm.skills
          ? publishForm.skills.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        budget: publishForm.budget || undefined,
        deadline: publishForm.deadline ? new Date(publishForm.deadline).getTime() : undefined,
        biddingDeadline: publishForm.biddingDeadline
          ? new Date(publishForm.biddingDeadline).getTime()
          : undefined,
        parentId: publishForm.parentId.trim() || undefined,
      });
      showToast(`发布成功: ${result.task.id}`, 'success');
      setPublishForm({ title: '', description: '', skills: '', budget: 0, deadline: '', biddingDeadline: '', parentId: '' });
      loadTasks();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const _handleBid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || bidding) return;
    setBidding(true);
    try {
      await client.bid({
        taskId: bidForm.taskId,
        price: bidForm.price,
        eta: bidForm.eta ? parseInt(bidForm.eta) : undefined,
        approach: bidForm.approach.trim() || undefined,
        confidence: bidForm.confidence || undefined,
      });
      showToast('竞标成功', 'success');
      setBidForm({ taskId: '', price: 0, eta: '', approach: '', confidence: 0.5 });
      loadTasks();
      if (selectedTask?.id === bidForm.taskId) {
        const bidResult = await client.bids({ taskId: bidForm.taskId });
        setBids(bidResult.bids);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '竞标失败', 'error');
    } finally {
      setBidding(false);
    }
  };

  type CasAction = 'award' | 'complete' | 'fail' | 'review' | 'reassign' | 'cancel' | 'progress';

const executeCasAction = async (
    action: CasAction,
    params: Record<string, unknown>
  ) => {
    if (!client || executingAction) return;
    setExecutingAction(action);
    try {
      let result: TaskMutationResult | AwardResult;
      switch (action) {
        case 'award':
          result = await client.award({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            awardeeId: (params.awardeeId as string) || undefined,
            strategy: (params.strategy as 'manual' | 'auto') || 'manual',
          });
          break;
        case 'complete':
          result = await client.complete({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            note: (params.note as string) || undefined,
            artifacts: (params.artifacts as string[])
              ? (params.artifacts as string).split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
          break;
        case 'fail':
          result = await client.fail({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            reason: (params.reason as string) || undefined,
          });
          break;
        case 'review':
          result = await client.review({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            decision: reviewDecision,
            comment: reviewComment.trim() || undefined,
          });
          break;
        case 'reassign':
          result = await client.reassign({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            toAgentId: reassignTarget.trim(),
            reason: reassignReason.trim() || undefined,
          });
          break;
        case 'cancel':
          result = await client.cancel({
            taskId: actionTaskId,
            expectedVersion: actionExpectedVersion,
            reason: cancelReason.trim() || undefined,
          });
          break;
        default:
          throw new Error('Unknown action');
      }
      showToast(`${action} 成功`, 'success');
      loadTasks();
      if (selectedTask?.id === actionTaskId) {
        const fresh = await client.getTask({ taskId: actionTaskId });
        setSelectedTask(fresh);
        setActionExpectedVersion(fresh.version);
        const bidResult = await client.bids({ taskId: actionTaskId });
        setBids(bidResult.bids);
      }
    } catch (err) {
      showToast(mapTaskActionError(err, action, actionExpectedVersion).message, 'error');
    } finally {
      setExecutingAction(null);
    }
  };

  const formatTime = (ts: number | null | undefined) =>
    ts ? new Date(ts).toLocaleString() : '—';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>任务看板</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['', 'open', 'bidding', 'awarded', 'in_progress', 'review', 'done', 'failed', 'cancelled'] as (TaskStatus | '')[]).map((s) => (
            <button
              key={s || 'all'}
              onClick={() => {
                setStatusFilter(s);
                setOffset(0);
              }}
              className={`btn ${statusFilter === s ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {s || '全部'}
            </button>
          ))}
        </div>
      </div>

      {/* Publish Task Modal */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>发布新任务</h2>
        <form onSubmit={handlePublish} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
          <div className="form-group">
            <label>标题 *</label>
            <input
              type="text"
              value={publishForm.title}
              onChange={(e) => setPublishForm({ ...publishForm, title: e.target.value })}
              placeholder="任务标题"
              required
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>描述</label>
            <textarea
              value={publishForm.description}
              onChange={(e) => setPublishForm({ ...publishForm, description: e.target.value })}
              placeholder="任务描述"
              rows={3}
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>所需技能 (逗号分隔)</label>
            <input
              type="text"
              value={publishForm.skills}
              onChange={(e) => setPublishForm({ ...publishForm, skills: e.target.value })}
              placeholder="typescript, react, testing"
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>预算</label>
            <input
              type="number"
              min="0"
              step="1"
              value={publishForm.budget}
              onChange={(e) => setPublishForm({ ...publishForm, budget: parseInt(e.target.value) || 0 })}
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>截止时间</label>
            <input
              type="datetime-local"
              value={publishForm.deadline}
              onChange={(e) => setPublishForm({ ...publishForm, deadline: e.target.value })}
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>竞标截止时间</label>
            <input
              type="datetime-local"
              value={publishForm.biddingDeadline}
              onChange={(e) => setPublishForm({ ...publishForm, biddingDeadline: e.target.value })}
              disabled={publishing}
            />
          </div>
          <div className="form-group">
            <label>父任务 ID (可选)</label>
            <input
              type="text"
              value={publishForm.parentId}
              onChange={(e) => setPublishForm({ ...publishForm, parentId: e.target.value })}
              placeholder="tsk_..."
              disabled={publishing}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={publishing || !publishForm.title.trim()}>
              {publishing ? '发布中...' : '发布任务'}
            </button>
          </div>
        </form>
      </div>

      {/* Task List */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>任务列表 (共 {total} 个)</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-ghost"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0 || loading}
            >
              上一页
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total || loading}
            >
              下一页
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '120px' }}>ID</th>
                <th>标题</th>
                <th style={{ width: '100px' }}>状态</th>
                <th style={{ width: '80px' }}>版本</th>
                <th style={{ width: '120px' }}>负责人</th>
                <th style={{ width: '80px' }}>进度</th>
                <th style={{ width: '140px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>
                    <div className="spinner" style={{ margin: '0 auto' }} />
                  </td>
                </tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-muted)' }}>
                    暂无任务
                  </td>
                </tr>
              ) : (
                tasks.map((task) => (
                  <tr key={task.id} onClick={() => handleViewTask(task)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{task.id.slice(0, 16)}...</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{task.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                        {task.requiredSkills.length > 0 && task.requiredSkills.join(', ')}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[task.status]}`}>
                        {STATUS_LABEL[task.status]}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{task.version}</td>
                    <td>{task.assignee || <span style={{ color: 'var(--fg-muted)' }}>—</span>}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            width: 60,
                            height: 6,
                            background: 'var(--border)',
                            borderRadius: 3,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${task.progress}%`,
                              height: '100%',
                              background:
                                task.status === 'done'
                                  ? 'var(--accent)'
                                  : task.status === 'failed'
                                  ? 'var(--danger)'
                                  : 'var(--warning)',
                              transition: 'width var(--transition)',
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 12, fontFamily: 'monospace' }}>
                          {formatPercent(task.progress)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleViewTask(task);
                        }}
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 8px' }}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Task Detail Modal */}
      {showDetail && selectedTask && (
        <div className="modal-overlay" onClick={() => setShowDetail(false)}>
          <div className="modal" style={{ maxWidth: '700px', maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 className="modal-title">{selectedTask.title}</h2>
              <button onClick={() => setShowDetail(false)} className="btn btn-ghost">关闭</button>
            </div>

            <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
              <div className="form-row">
                <div>
                  <label>ID</label>
                  <code style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{selectedTask.id}</code>
                </div>
                <div>
                  <label>版本</label>
                  <code style={{ fontSize: 12 }}>{selectedTask.version}</code>
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>状态</label>
                  <span className={`badge ${STATUS_BADGE[selectedTask.status]}`}>{STATUS_LABEL[selectedTask.status]}</span>
                </div>
                <div>
                  <label>负责人</label>
                  <code style={{ fontSize: 12 }}>{selectedTask.assignee || '—'}</code>
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>进度</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        background: 'var(--border)',
                        borderRadius: 4,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${selectedTask.progress}%`,
                          height: '100%',
                          background:
                            selectedTask.status === 'done'
                              ? 'var(--accent)'
                              : selectedTask.status === 'failed'
                              ? 'var(--danger)'
                              : 'var(--warning)',
                        }}
                      />
                    </div>
                    <span style={{ fontFamily: 'monospace' }}>{formatPercent(selectedTask.progress)}</span>
                  </div>
                </div>
                <div>
                  <label>预算</label>
                  <code style={{ fontSize: 12 }}>{selectedTask.budget}</code>
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>技能</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {selectedTask.requiredSkills.map((s) => (
                      <span key={s} className="badge badge-open" style={{ fontSize: 10 }}>{s}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <label>父任务</label>
                  <code style={{ fontSize: 12 }}>{selectedTask.parentId || '—'}</code>
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>竞标截止</label>
                  <code style={{ fontSize: 12 }}>{formatTime(selectedTask.biddingDeadline)}</code>
                </div>
                <div>
                  <label>任务截止</label>
                  <code style={{ fontSize: 12 }}>{formatTime(selectedTask.deadline)}</code>
                </div>
              </div>
              <div className="form-row">
                <div>
                  <label>完成时间</label>
                  <code style={{ fontSize: 12 }}>{formatTime(selectedTask.completedAt)}</code>
                </div>
                <div>
                  <label>阻塞由</label>
                  <code style={{ fontSize: 12 }}>{selectedTask.blockedBy.length > 0 ? selectedTask.blockedBy.join(', ') : '—'}</code>
                </div>
              </div>
              <div>
                <label>描述</label>
                <p style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{selectedTask.description || '—'}</p>
              </div>
            </div>

            {/* Bids */}
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>竞标列表 ({bids.length})</h3>
              {bids.length === 0 ? (
                <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>暂无竞标</p>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 200, overflow: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '120px' }}>Bid ID</th>
                        <th>Agent</th>
                        <th style={{ width: '80px' }}>报价</th>
                        <th style={{ width: '80px' }}>ETA</th>
                        <th style={{ width: '80px' }}>置信度</th>
                        <th>方案</th>
                        <th style={{ width: '140px' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bids.map((bid) => (
                        <tr key={bid.bidId}>
                          <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{bid.bidId.slice(0, 16)}...</td>
                          <td>{bid.agentId}</td>
                          <td>{bid.price}</td>
                          <td>{bid.eta ?? '—'}</td>
                          <td>{bid.confidence !== null ? bid.confidence.toFixed(2) : '—'}</td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {bid.approach || '—'}
                          </td>
                          <td>
                            {selectedTask.status === 'bidding' && (
                              <button
                                onClick={() => {
                                  setActionTaskId(selectedTask.id);
                                  setActionExpectedVersion(selectedTask.version);
                                  executeCasAction('award', { awardeeId: bid.agentId, strategy: 'manual' });
                                }}
                                className="btn btn-primary"
                                style={{ fontSize: 11, padding: '4px 8px' }}
                                disabled={executingAction !== null}
                              >
                                授标
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>操作</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                {/*
                  Award: bidding → awarded (admin)
                */}
                {selectedTask.status === 'bidding' && (
                  <div className="card" style={{ padding: 12 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>授标</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>指定 Agent (可选，留空则自动评分)</label>
                      <input
                        type="text"
                        value={reassignTarget}
                        onChange={(e) => setReassignTarget(e.target.value)}
                        placeholder="agt_..."
                      />
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={() => executeCasAction('award', { awardeeId: reassignTarget.trim() || undefined, strategy: 'manual' })}
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'award' ? '执行中...' : '确认授标'}
                    </button>
                  </div>
                )}

                {/*
                  Progress: awarded/in_progress → in_progress (assignee)
                */}
                {(selectedTask.status === 'awarded' || selectedTask.status === 'in_progress') && (
                  <div className="card" style={{ padding: 12 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>上报进度</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Progress (0-100)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={actionProgress}
                        onChange={(e) => setActionProgress(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>备注 (可选)</label>
                      <input
                        type="text"
                        value={actionNote}
                        onChange={(e) => setActionNote(e.target.value)}
                        placeholder="进度说明"
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>产物引用 (逗号分隔，可选)</label>
                      <input
                        type="text"
                        value={actionArtifacts}
                        onChange={(e) => setActionArtifacts(e.target.value)}
                        placeholder="ref://artifact1, ref://artifact2"
                      />
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        executeCasAction('progress', {
                          note: actionNote.trim() || undefined,
                          artifacts: actionArtifacts
                            ? actionArtifacts.split(',').map((s) => s.trim()).filter(Boolean)
                            : undefined,
                        })
                      }
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'progress' ? '执行中...' : '提交进度'}
                    </button>
                  </div>
                )}

                {/*
                  Complete: in_progress → review (assignee)
                */}
                {selectedTask.status === 'in_progress' && (
                  <div className="card" style={{ padding: 12 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>提交审核</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>备注 (可选)</label>
                      <input
                        type="text"
                        value={actionNote}
                        onChange={(e) => setActionNote(e.target.value)}
                        placeholder="提交说明"
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>产物引用 (逗号分隔，可选)</label>
                      <input
                        type="text"
                        value={actionArtifacts}
                        onChange={(e) => setActionArtifacts(e.target.value)}
                        placeholder="ref://artifact1, ref://artifact2"
                      />
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        executeCasAction('complete', {
                          note: actionNote.trim() || undefined,
                          artifacts: actionArtifacts
                            ? actionArtifacts.split(',').map((s) => s.trim()).filter(Boolean)
                            : undefined,
                        })
                      }
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'complete' ? '执行中...' : '提交审核'}
                    </button>
                  </div>
                )}

                {/*
                  Fail: awarded/in_progress → failed (assignee or admin)
                */}
                {(selectedTask.status === 'awarded' || selectedTask.status === 'in_progress') && (
                  <div className="card" style={{ padding: 12, borderColor: 'var(--danger)' }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>标记失败</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>失败原因 (可选)</label>
                      <textarea
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        placeholder="失败原因"
                        rows={2}
                      />
                    </div>
                    <button
                      className="btn btn-danger"
                      onClick={() => executeCasAction('fail', { reason: cancelReason.trim() || undefined })}
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'fail' ? '执行中...' : '确认失败'}
                    </button>
                  </div>
                )}

                {/*
                  Review: review → done/in_progress (admin)
                */}
                {selectedTask.status === 'review' && (
                  <div className="card" style={{ padding: 12 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>审核决策</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>决策</label>
                      <select
                        value={reviewDecision}
                        onChange={(e) => setReviewDecision(e.target.value as 'approve' | 'reject' | 'request-revision')}
                        style={{ width: '100%' }}
                      >
                        <option value="approve">✅ Approve → Done</option>
                        <option value="reject">❌ Reject → In Progress</option>
                        <option value="request-revision">🔄 Request Revision → In Progress</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>备注 (可选)</label>
                      <textarea
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                        placeholder="审核意见"
                        rows={2}
                      />
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={() => executeCasAction('review', {})}
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'review' ? '执行中...' : '确认审核'}
                    </button>
                  </div>
                )}

                {/*
                  Reassign: awarded/in_progress/review → in_progress (admin)
                */}
                {(selectedTask.status === 'awarded' || selectedTask.status === 'in_progress' || selectedTask.status === 'review') && (
                  <div className="card" style={{ padding: 12 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>改派</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>目标 Agent ID *</label>
                      <input
                        type="text"
                        value={reassignTarget}
                        onChange={(e) => setReassignTarget(e.target.value)}
                        placeholder="agt_..."
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>原因 (可选)</label>
                      <input
                        type="text"
                        value={reassignReason}
                        onChange={(e) => setReassignReason(e.target.value)}
                        placeholder="改派原因"
                      />
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={() => executeCasAction('reassign', {})}
                      disabled={executingAction !== null || !reassignTarget.trim()}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'reassign' ? '执行中...' : '确认改派'}
                    </button>
                  </div>
                )}

                {/*
                  Cancel: open/bidding/in_progress/review → cancelled (admin)
                */}
                {(selectedTask.status === 'open' || selectedTask.status === 'bidding' || selectedTask.status === 'in_progress' || selectedTask.status === 'review') && (
                  <div className="card" style={{ padding: 12, borderColor: 'var(--warning)' }}>
                    <h4 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--warning)' }}>取消任务</h4>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>Expected Version</label>
                      <input
                        type="number"
                        min="0"
                        value={actionExpectedVersion}
                        onChange={(e) => setActionExpectedVersion(parseInt(e.target.value) || 0)}
                        style={{ width: 100 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 8 }}>
                      <label>取消原因 (可选)</label>
                      <textarea
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        placeholder="取消原因"
                        rows={2}
                      />
                    </div>
                    <button
                      className="btn btn-danger"
                      onClick={() => executeCasAction('cancel', { reason: cancelReason.trim() || undefined })}
                      disabled={executingAction !== null}
                      style={{ width: '100%' }}
                    >
                      {executingAction === 'cancel' ? '执行中...' : '确认取消'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}