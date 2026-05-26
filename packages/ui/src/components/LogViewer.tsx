import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { X, RefreshCw, Download, Trash2, ArrowLeft, File, Layers, Bug } from 'lucide-react';

interface LogViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string; // 现在这个字段直接包含原始JSON字符串
  source?: string;
  reqId?: string;
  [key: string]: any; // 允许动态属性，如msg、url、body等
}

interface LogFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

interface GroupedLogs {
  [reqId: string]: LogEntry[];
}

interface LogGroupSummary {
  reqId: string;
  logCount: number;
  firstLog: string;
  lastLog: string;
  model?: string;
}

interface GroupedLogsResponse {
  grouped: boolean;
  groups: { [reqId: string]: LogEntry[] };
  summary: {
    totalRequests: number;
    totalLogs: number;
    requests: LogGroupSummary[];
  };
}

export function LogViewer({ open, onOpenChange, showToast }: LogViewerProps) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<string[]>([]);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<LogFile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [groupByReqId, setGroupByReqId] = useState(false);
  const [groupedLogs, setGroupedLogs] = useState<GroupedLogsResponse | null>(null);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [expandedLogIndex, setExpandedLogIndex] = useState<number | null>(null);
  const [debugLogEnabled, setDebugLogEnabled] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (open) {
      loadLogFiles();
      api.getDebugLogStatus().then(res => setDebugLogEnabled(res.enabled)).catch(() => {});
    }
  }, [open]);

  // 创建内联 Web Worker
  const createInlineWorker = (): Worker => {
    const workerCode = `
      // 日志聚合Web Worker
      self.onmessage = function(event) {
        const { type, data } = event.data;
        
        if (type === 'groupLogsByReqId') {
          try {
            const { logs } = data;
            
            // 按reqId聚合日志
            const groupedLogs = {};
            
            logs.forEach((log, index) => {
              log = JSON.parse(log);
              let reqId = log.reqId || 'no-req-id';
              
              if (!groupedLogs[reqId]) {
                groupedLogs[reqId] = [];
              }
              groupedLogs[reqId].push(log);
            });

            // 按时间戳排序每个组的日志
            Object.keys(groupedLogs).forEach(reqId => {
              groupedLogs[reqId].sort((a, b) => a.time - b.time);
            });

            // 提取model信息
            const extractModelInfo = (reqId) => {
              const logGroup = groupedLogs[reqId];
              for (const log of logGroup) {
                try {
                  // 尝试从message字段解析JSON
                  if (log.type === 'request body' && log.data && log.data.model) {
                    return log.data.model;
                  }
                } catch (e) {
                  // 解析失败，继续尝试下一条日志
                }
              }
              return undefined;
            };

            // 生成摘要信息
            const summary = {
              totalRequests: Object.keys(groupedLogs).length,
              totalLogs: logs.length,
              requests: Object.keys(groupedLogs).map(reqId => ({
                reqId,
                logCount: groupedLogs[reqId].length,
                firstLog: groupedLogs[reqId][0]?.time,
                lastLog: groupedLogs[reqId][groupedLogs[reqId].length - 1]?.time,
                model: extractModelInfo(reqId)
              }))
            };

            const response = {
              grouped: true,
              groups: groupedLogs,
              summary
            };

            // 发送结果回主线程
            self.postMessage({
              type: 'groupLogsResult',
              data: response
            });
          } catch (error) {
            // 发送错误回主线程
            self.postMessage({
              type: 'error',
              error: error instanceof Error ? error.message : 'Unknown error occurred'
            });
          }
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    return new Worker(workerUrl);
  };

  // 初始化Web Worker
  useEffect(() => {
    if (typeof Worker !== 'undefined') {
      try {
        // 创建内联Web Worker
        workerRef.current = createInlineWorker();

        // 监听Worker消息
        workerRef.current.onmessage = (event) => {
          const { type, data, error } = event.data;

          if (type === 'groupLogsResult') {
            setGroupedLogs(data);
          } else if (type === 'error') {
            console.error('Worker error:', error);
            if (showToast) {
              showToast(t('log_viewer.worker_error') + ': ' + error, 'error');
            }
          }
        };

        // 监听Worker错误
        workerRef.current.onerror = (error) => {
          console.error('Worker error:', error);
          if (showToast) {
            showToast(t('log_viewer.worker_init_failed'), 'error');
          }
        };
      } catch (error) {
        console.error('Failed to create worker:', error);
        if (showToast) {
          showToast(t('log_viewer.worker_init_failed'), 'error');
        }
      }
    }

    // 清理Worker
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [showToast, t]);

  useEffect(() => {
    if (autoRefresh && open && selectedFile) {
      refreshInterval.current = setInterval(() => {
        loadLogs();
      }, 5000); // Refresh every 5 seconds
    } else if (refreshInterval.current) {
      clearInterval(refreshInterval.current);
    }

    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }
    };
  }, [autoRefresh, open, selectedFile]);

  // Load logs when selected file changes
  useEffect(() => {
    if (selectedFile && open) {
      setLogs([]); // Clear existing logs
      loadLogs();
    }
  }, [selectedFile, open]);

  // Handle open/close animations
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      // Trigger the animation after a small delay to ensure the element is rendered
      requestAnimationFrame(() => {
        setIsAnimating(true);
      });
    } else {
      setIsAnimating(false);
      // Wait for the animation to complete before hiding
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const loadLogFiles = async () => {
    try {
      setIsLoading(true);
      const response = await api.getLogFiles();

      if (response && Array.isArray(response)) {
        setLogFiles(response);
        setSelectedFile(null);
        setLogs([]);
      } else {
        setLogFiles([]);
        if (showToast) {
          showToast(t('log_viewer.no_log_files_available'), 'warning');
        }
      }
    } catch (error) {
      console.error('Failed to load log files:', error);
      if (showToast) {
        showToast(t('log_viewer.load_files_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadLogs = async () => {
    if (!selectedFile) return;

    try {
      setIsLoading(true);
      setGroupedLogs(null);
      setSelectedReqId(null);

      // 始终加载原始日志数据
      const response = await api.getLogs(selectedFile.path);

      if (response && Array.isArray(response)) {
        // 现在接口返回的是原始日志字符串数组，直接存储
        setLogs(response);

        // 如果启用了分组，使用Web Worker进行聚合（需要转换为LogEntry格式供Worker使用）
        if (groupByReqId && workerRef.current) {
          // const workerLogs: LogEntry[] = response.map((logLine, index) => ({
          //   timestamp: new Date().toISOString(),
          //   level: 'info',
          //   message: logLine,
          //   source: undefined,
          //   reqId: undefined
          // }));

          workerRef.current.postMessage({
            type: 'groupLogsByReqId',
            data: { logs: response }
          });
        } else {
          setGroupedLogs(null);
        }
      } else {
        setLogs([]);
        setGroupedLogs(null);
        if (showToast) {
          showToast(t('log_viewer.no_logs_available'), 'warning');
        }
      }
    } catch (error) {
      console.error('Failed to load logs:', error);
      if (showToast) {
        showToast(t('log_viewer.load_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!selectedFile) return;

    try {
      await api.clearLogs(selectedFile.path);
      setLogs([]);
      if (showToast) {
        showToast(t('log_viewer.logs_cleared'), 'success');
      }
    } catch (error) {
      console.error('Failed to clear logs:', error);
      if (showToast) {
        showToast(t('log_viewer.clear_failed') + ': ' + (error as Error).message, 'error');
      }
    }
  };

  const selectFile = (file: LogFile) => {
    setSelectedFile(file);
    setAutoRefresh(false); // Reset auto refresh when changing files
  };


  const toggleGroupByReqId = () => {
    const newValue = !groupByReqId;
    setGroupByReqId(newValue);

    if (newValue && selectedFile && logs.length > 0) {
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'groupLogsByReqId',
          data: { logs }
        });
      }
    } else if (!newValue) {
      setGroupedLogs(null);
      setSelectedReqId(null);
    }
  };

  const toggleDebugLog = async () => {
    try {
      const newState = !debugLogEnabled;
      const res = await api.setDebugLogStatus(newState);
      setDebugLogEnabled(res.enabled);
      if (showToast) {
        showToast(
          res.enabled ? t('log_viewer.debug_log_enabled', 'Debug logging enabled') : t('log_viewer.debug_log_disabled', 'Debug logging disabled'),
          res.enabled ? 'success' : 'warning'
        );
      }
    } catch {
      if (showToast) showToast(t('log_viewer.debug_log_error', 'Failed to toggle debug log'), 'error');
    }
  };

  const selectReqId = (reqId: string) => {
    setSelectedReqId(reqId);
  };


  const getDisplayLogs = (): string[] => {
    if (groupByReqId && groupedLogs) {
      if (selectedReqId && groupedLogs.groups[selectedReqId]) {
        return groupedLogs.groups[selectedReqId].map(log =>
          typeof log === 'string' ? log : JSON.stringify(log)
        );
      }
      return logs;
    }
    return logs;
  };

  const downloadLogs = () => {
    if (!selectedFile || logs.length === 0) return;

    // Download the currently formatted log output.
    const logText = formatLogsForEditor();

    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedFile.name}-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (showToast) {
      showToast(t('log_viewer.logs_downloaded'), 'success');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // 面包屑导航项类型
  interface BreadcrumbItem {
    id: string;
    label: string;
    onClick: () => void;
  }

  // 获取面包屑导航项
  const getBreadcrumbs = (): BreadcrumbItem[] => {
    const breadcrumbs: BreadcrumbItem[] = [
      {
        id: 'root',
        label: t('log_viewer.title'),
        onClick: () => {
          setSelectedFile(null);
          setAutoRefresh(false);
          setLogs([]);
          setGroupedLogs(null);
          setSelectedReqId(null);
          setGroupByReqId(false);
        }
      }
    ];

    if (selectedFile) {
      breadcrumbs.push({
        id: 'file',
        label: selectedFile.name,
        onClick: () => {
          if (groupByReqId) {
            // 如果在分组模式下，点击文件层级应该返回到分组列表
            setSelectedReqId(null);
          } else {
            // 如果不在分组模式下，点击文件层级关闭分组功能
            setSelectedReqId(null);
            setGroupedLogs(null);
            setGroupByReqId(false);
          }
        }
      });
    }

    if (selectedReqId) {
      breadcrumbs.push({
        id: 'req',
        label: `${t('log_viewer.request')} ${selectedReqId}`,
        onClick: () => {
          // 点击当前层级时不做任何操作
        }
      });
    }

    return breadcrumbs;
  };

  // 获取返回按钮的处理函数
  const getBackAction = (): (() => void) | null => {
    if (selectedReqId) {
      return () => {
        setSelectedReqId(null);
      };
    } else if (selectedFile) {
      return () => {
        setSelectedFile(null);
        setAutoRefresh(false);
        setLogs([]);
        setGroupedLogs(null);
        setSelectedReqId(null);
        setGroupByReqId(false);
      };
    }
    return null;
  };

  const formatLogsForEditor = () => {
    // 如果在分组模式且选中了具体请求，显示该请求的日志
    if (groupByReqId && groupedLogs && selectedReqId && groupedLogs.groups[selectedReqId]) {
      const requestLogs = groupedLogs.groups[selectedReqId];
      // 提取原始JSON字符串并每行一个
      return requestLogs.map(log => JSON.stringify(log)).join('\n');
    }

    // 其他情况，直接显示原始日志字符串数组，每行一个
    return logs.join('\n');
  };

  if (!isVisible && !open) {
    return null;
  }

  return (
    <>
      {(isVisible || open) && (
        <div
          className={`fixed inset-0 z-50 transition-all duration-300 ease-out ${
            isAnimating && open ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
          }`}
          onClick={() => onOpenChange(false)}
        />
      )}

      <div
        ref={containerRef}
        className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-white shadow-2xl transition-all duration-300 ease-out transform ${
          isAnimating && open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{
          height: '100vh',
          maxHeight: '100vh'
        }}
      >
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-2">
            {getBackAction() ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={getBackAction()!}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('log_viewer.back')}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('log_viewer.close')}
              </Button>
            )}

            {/* 面包屑导航 */}
            <nav className="flex items-center space-x-1 text-sm">
              {getBreadcrumbs().map((breadcrumb, index) => (
                <React.Fragment key={breadcrumb.id}>
                  {index > 0 && (
                    <span className="text-gray-400 mx-1">/</span>
                  )}
                  {index === getBreadcrumbs().length - 1 ? (
                    <span className="text-gray-900 font-medium">
                      {breadcrumb.label}
                    </span>
                  ) : (
                    <button
                      onClick={breadcrumb.onClick}
                      className="text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      {breadcrumb.label}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </nav>
          </div>
          <div className="flex gap-2">
            {selectedFile && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleGroupByReqId}
                  className={groupByReqId ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <Layers className="h-4 w-4 mr-2" />
                  {groupByReqId ? t('log_viewer.grouped_on') : t('log_viewer.group_by_req_id')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className={autoRefresh ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`} />
                  {autoRefresh ? t('log_viewer.auto_refresh_on') : t('log_viewer.auto_refresh_off')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleDebugLog}
                  className={debugLogEnabled ? 'bg-orange-100 text-orange-700' : ''}
                  title={debugLogEnabled ? t('log_viewer.debug_log_disable_tooltip', 'Disable provider debug logging') : t('log_viewer.debug_log_enable_tooltip', 'Enable provider debug logging')}
                >
                  <Bug className={`h-4 w-4 mr-2`} />
                  {debugLogEnabled ? t('log_viewer.debug_log_on', 'Debug ON') : t('log_viewer.debug_log_off', 'Debug OFF')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadLogs}
                  disabled={logs.length === 0}
                >
                  <Download className="h-4 w-4 mr-2" />
                  {t('log_viewer.download')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearLogs}
                  disabled={logs.length === 0}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('log_viewer.clear')}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 bg-gray-50">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : selectedFile ? (
            <>
              {groupByReqId && groupedLogs && !selectedReqId ? (
                // 显示日志组列表
                <div className="flex flex-col h-full p-6">
                  <div className="mb-4 flex-shrink-0">
                    <h3 className="text-lg font-medium mb-2">{t('log_viewer.request_groups')}</h3>
                    <p className="text-sm text-gray-600">
                      {t('log_viewer.total_requests')}: {groupedLogs.summary.totalRequests} |
                      {t('log_viewer.total_logs')}: {groupedLogs.summary.totalLogs}
                    </p>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
                    {groupedLogs.summary.requests.map((request) => (
                      <div
                        key={request.reqId}
                        className="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                        onClick={() => selectReqId(request.reqId)}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <File className="h-5 w-5 text-blue-600" />
                            <span className="font-medium text-sm">{request.reqId}</span>
                            {request.model && (
                              <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                                {request.model}
                              </span>
                            )}
                          </div>
                          <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                            {request.logCount} {t('log_viewer.logs')}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 space-y-1">
                          <div>{t('log_viewer.first_log')}: {formatDate(request.firstLog)}</div>
                          <div>{t('log_viewer.last_log')}: {formatDate(request.lastLog)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                // Structured log table view
                <div className="flex flex-col h-full">
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-50 border-b z-10">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 w-[140px]">{t('log_viewer.col_time')}</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 w-[70px]">{t('log_viewer.col_level')}</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 w-[80px]">{t('log_viewer.col_request_id')}</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600">{t('log_viewer.col_message')}</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 w-[150px]">{t('log_viewer.col_model')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {getDisplayLogs().map((logStr, index) => {
                          try {
                            const log = JSON.parse(logStr);
                            const isExpanded = expandedLogIndex === index;
                            const level = typeof log.level === 'number' ? log.level : 30;
                            const levelLabel = level <= 10 ? 'trace' : level <= 20 ? 'debug' : level <= 30 ? 'info' : level <= 40 ? 'warn' : 'error';
                            const levelColor = level <= 10 ? 'bg-gray-100 text-gray-700' : level <= 20 ? 'bg-blue-100 text-blue-700' : level <= 30 ? 'bg-green-100 text-green-700' : level <= 40 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700';
                            const timeStr = log.time ? new Date(log.time).toLocaleTimeString() : '-';
                            const msg = log.msg || '';
                            const reqId = log.reqId || '';
                            const model = log.data?.model || log.model || '';

                            return (
                              <React.Fragment key={index}>
                                <tr
                                  className={`border-b cursor-pointer hover:bg-gray-50 ${isExpanded ? 'bg-blue-50' : ''}`}
                                  onClick={() => setExpandedLogIndex(isExpanded ? null : index)}
                                >
                                  <td className="px-3 py-1.5 text-gray-600 font-mono whitespace-nowrap">{timeStr}</td>
                                  <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${levelColor}`}>{levelLabel}</span></td>
                                  <td className="px-3 py-1.5 text-gray-500 font-mono truncate max-w-[80px]" title={reqId}>{reqId || '-'}</td>
                                  <td className="px-3 py-1.5 text-gray-800 truncate max-w-[400px]" title={msg}>{msg}</td>
                                  <td className="px-3 py-1.5 text-gray-500 truncate max-w-[150px]" title={model}>{model || '-'}</td>
                                </tr>
                                {isExpanded && (
                                  <tr>
                                    <td colSpan={5} className="bg-gray-50 px-4 py-3">
                                      <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto">
                                        {JSON.stringify(log, null, 2)}
                                      </pre>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          } catch {
                            return (
                              <tr key={index} className="border-b">
                                <td colSpan={5} className="px-3 py-1.5 text-gray-400 italic">{logStr.substring(0, 200)}</td>
                              </tr>
                            );
                          }
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="p-6">
              <h3 className="text-lg font-medium mb-4">{t('log_viewer.select_file')}</h3>
              {logFiles.length === 0 ? (
                <div className="text-gray-500 text-center py-8">
                  <File className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>{t('log_viewer.no_log_files_available')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {logFiles.map((file) => (
                    <div
                      key={file.path}
                      className="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => selectFile(file)}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <File className="h-5 w-5 text-blue-600" />
                          <span className="font-medium text-sm">{file.name}</span>
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 space-y-1">
                        <div>{formatFileSize(file.size)}</div>
                        <div>{formatDate(file.lastModified)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
