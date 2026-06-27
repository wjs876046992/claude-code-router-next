import type { ClientApplyResponse, ClientId, ClientStatus, CodexAccountOperationResponse, CodexAccountsResponse, CodexRefreshTokenExportResponse, Config, ProjectConfigEntry, ProjectsResponse, ProviderQuotaResponse } from '@/types';

// API Client Class for handling requests with baseUrl and apikey authentication
class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private tempApiKey: string | null;

  constructor(baseUrl: string = '/api', apiKey: string = '') {
    this.baseUrl = baseUrl;
    // Load API key from localStorage if available
    this.apiKey = apiKey || localStorage.getItem('apiKey') || '';
    // Load temp API key from URL if available
    this.tempApiKey = new URLSearchParams(window.location.search).get('tempApiKey');
  }

  // Update base URL
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  // Update API key
  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    // Save API key to localStorage
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey);
    } else {
      localStorage.removeItem('apiKey');
    }
  }

  // Update temp API key
  setTempApiKey(tempApiKey: string | null) {
    this.tempApiKey = tempApiKey;
  }

  // Create headers with API key authentication
  private createHeaders(contentType: string = 'application/json'): HeadersInit {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  // Generic fetch wrapper with base URL and authentication
  private async apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const config: RequestInit = {
      ...options,
      headers: {
        ...this.createHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);

      // Handle 401 Unauthorized responses
      if (response.status === 401) {
        // Remove API key when it's invalid
        localStorage.removeItem('apiKey');
        // Redirect to login page if not already there
        // For memory router, we need to use the router instance
        // We'll dispatch a custom event that the app can listen to
        window.dispatchEvent(new CustomEvent('unauthorized'));
        // Return a promise that never resolves to prevent further execution
        return new Promise(() => {}) as Promise<T>;
      }

      if (!response.ok) {
        // Try to get detailed error message from response body
        let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error || errorData.message) {
            errorMessage = errorData.message || errorData.error || errorMessage;
          }
        } catch {
          // If parsing fails, use default error message
        }
        throw new Error(errorMessage);
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);

    } catch (error) {
      console.error('API request error:', error);
      throw error;
    }
  }

  // GET request
  async get<T>(endpoint: string): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'GET',
    });
  }

  // POST request
  async post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PUT request
  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // PATCH request
  async patch<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // DELETE request
  async delete<T>(endpoint: string, body?: any): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    });
  }

  // API methods for configuration
  // Get current configuration
  async getConfig(): Promise<Config> {
    return this.get<Config>('/config');
  }

  // Update entire configuration
  async updateConfig(config: Config): Promise<{ success: boolean; message?: string }> {
    return this.post<{ success: boolean; message?: string }>('/config', config);
  }

  // Restart service
  async restartService(): Promise<unknown> {
    return this.post<void>('/restart', {});
  }

  // Check for updates
  async checkForUpdates(): Promise<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }> {
    return this.get<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }>('/update/check');
  }

  // Perform update
  async performUpdate(): Promise<{ success: boolean; message: string }> {
    return this.post<{ success: boolean; message: string }>('/api/update/perform', {});
  }

  // Get log files list
  async getLogFiles(): Promise<Array<{ name: string; path: string; size: number; lastModified: string }>> {
    return this.get<Array<{ name: string; path: string; size: number; lastModified: string }>>('/logs/files');
  }

  // Get logs from specific file
  async getLogs(filePath: string): Promise<string[]> {
    return this.get<string[]>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Clear logs from specific file
  async clearLogs(filePath: string): Promise<void> {
    return this.delete<void>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Get debug log status
  async getDebugLogStatus(): Promise<{ enabled: boolean }> {
    return this.get<{ enabled: boolean }>('/debug-log');
  }

  // Toggle debug log
  async setDebugLogStatus(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.put<{ enabled: boolean }>('/debug-log', { enabled });
  }

  // ========== Client Integrations API methods ==========

  async getClients(): Promise<{ clients: ClientStatus[] }> {
    return this.get<{ clients: ClientStatus[] }>('/clients');
  }

  async applyClients(enabled: ClientId[]): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>('/clients/apply', { enabled });
  }

  async enableClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/enable`, {});
  }

  async disableClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/disable`, {});
  }

  async restoreClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/restore`, {});
  }

  async getCodexAccounts(): Promise<CodexAccountsResponse> {
    return this.get<CodexAccountsResponse>('/clients/codex/accounts');
  }

  async importCurrentCodexAccount(label?: string): Promise<CodexAccountOperationResponse> {
    return this.post<CodexAccountOperationResponse>('/clients/codex/accounts/import-current', { label });
  }

  async importCodexAccountFromRefreshToken(refreshToken: string, label?: string): Promise<CodexAccountOperationResponse> {
    return this.post<CodexAccountOperationResponse>('/clients/codex/accounts/import-rt', { refreshToken, label });
  }

  async activateCodexAccount(accountId: string): Promise<CodexAccountOperationResponse> {
    return this.post<CodexAccountOperationResponse>(`/clients/codex/accounts/${encodeURIComponent(accountId)}/activate`, {});
  }

  async deleteCodexAccount(accountId: string): Promise<CodexAccountOperationResponse> {
    return this.delete<CodexAccountOperationResponse>(`/clients/codex/accounts/${encodeURIComponent(accountId)}`);
  }

  async exportCodexRefreshToken(accountId?: string): Promise<CodexRefreshTokenExportResponse> {
    const endpoint = accountId
      ? `/clients/codex/accounts/${encodeURIComponent(accountId)}/export-rt`
      : '/clients/codex/accounts/export-rt';
    return this.post<CodexRefreshTokenExportResponse>(endpoint, {});
  }

  // ========== Project-Level Configuration API methods ==========

  async getProjects(): Promise<ProjectsResponse> {
    return this.get<ProjectsResponse>('/projects');
  }

  async addProject(path: string): Promise<ProjectConfigEntry> {
    return this.post<ProjectConfigEntry>('/projects', { path });
  }

  async updateProject(id: string, Router: Record<string, any>): Promise<ProjectConfigEntry> {
    return this.put<ProjectConfigEntry>(`/projects/${encodeURIComponent(id)}`, { Router });
  }

  async deleteProject(id: string): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/projects/${encodeURIComponent(id)}`);
  }

  async setProjectTakeover(id: string, clients: ClientId[]): Promise<{ id: string; path: string; ccrTakeover: boolean; ccrTakeoverClients: ClientId[] }> {
    return this.put<{ id: string; path: string; ccrTakeover: boolean; ccrTakeoverClients: ClientId[] }>(`/projects/${encodeURIComponent(id)}/takeover`, { clients });
  }

  // ========== Usage Statistics API methods ==========

  // Get usage records with summary
  async getUsage(params?: {
    startDate?: string; endDate?: string; model?: string;
    provider?: string; scenario?: string; clientType?: string; sessionId?: string;
    status?: "success" | "error";
    page?: number; pageSize?: number;
  }): Promise<{ records: any[]; summary: any; total: number; page: number; pageSize: number }> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    }
    const qs = query.toString();
    return this.get(`/usage${qs ? '?' + qs : ''}`);
  }

  // Get usage summary only
  async getUsageSummary(params?: { startDate?: string; endDate?: string; status?: "success" | "error" }): Promise<any> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    }
    const qs = query.toString();
    return this.get(`/usage/summary${qs ? '?' + qs : ''}`);
  }

  // Clear usage data
  async clearUsage(beforeDate?: string): Promise<{ success: boolean; message: string }> {
    const qs = beforeDate ? `?beforeDate=${encodeURIComponent(beforeDate)}` : '';
    return this.delete(`/usage${qs}`);
  }

  // ========== Preset API methods ==========

  // Get presets list
  async getPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets');
  }

  // Get preset details
  async getPreset(name: string): Promise<any> {
    return this.get<any>(`/presets/${encodeURIComponent(name)}`);
  }

  // Install preset from URL
  async installPresetFromUrl(url: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install', { url, name });
  }

  // Upload preset file
  async uploadPresetFile(file: File, name?: string): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    if (name) {
      formData.append('name', name);
    }

    const url = `${this.baseUrl}/presets/upload`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.status === 401) {
      localStorage.removeItem('apiKey');
      window.dispatchEvent(new CustomEvent('unauthorized'));
      return new Promise(() => {}) as any;
    }

    if (!response.ok) {
      throw new Error(`Failed to upload preset: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // Apply preset (configure sensitive fields)
  async applyPreset(name: string, secrets: Record<string, string>): Promise<any> {
    return this.post<any>(`/presets/${encodeURIComponent(name)}/apply`, { secrets });
  }

  // Delete preset
  async deletePreset(name: string): Promise<any> {
    return this.delete<any>(`/presets/${encodeURIComponent(name)}`, {});
  }

  // Get market presets
  async getMarketPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets/market');
  }

  // Install preset from GitHub repository
  async installPresetFromGitHub(repo: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install/github', { repo, name });
  }

  // ========== Provider Health API methods ==========

  // Get provider health status
  async getProviderHealth(): Promise<{
    states: Array<{
      provider: string;
      model: string;
      status: 'closed' | 'open' | 'half-open';
      failureCount: number;
      successCount: number;
      lastFailureTime: number;
      lastError?: string;
    }>;
    timestamp: string;
  }> {
    return this.get('/providers/health');
  }

  // Get provider quota usage (5h and 7d windows)
  async getProviderQuota(): Promise<ProviderQuotaResponse> {
    return this.get<ProviderQuotaResponse>('/providers/quota');
  }

  async probeProvider(providerName: string): Promise<{ provider: string; success: boolean; timestamp: string }> {
    return this.post<{ provider: string; success: boolean; timestamp: string }>('/providers/probe', { providerName });
  }

  async probeAllProviders(): Promise<{ results: Array<{ provider: string; success: boolean }>; successCount: number; total: number; timestamp: string }> {
    return this.post<{ results: Array<{ provider: string; success: boolean }>; successCount: number; total: number; timestamp: string }>('/providers/probe-all', {});
  }
}

// Create a default instance of the API client
export const api = new ApiClient();

// Export the class for creating custom instances
export default ApiClient;
