---
title: Usage API
---

# Usage API

Claude Code Router records request usage for the Web UI and usage endpoints. The HTTP API response shape is unchanged: records still use camelCase fields and summary objects that match the existing UI contract.

## Storage

Usage data is stored in SQLite at:

```text
~/.claude-code-router/data/usage.sqlite
```

The database is initialized lazily when usage data is first read or written. CCR keeps recent usage only and automatically deletes rows older than 180 days during database initialization and periodic append-time retention checks.

### Legacy JSONL migration

Older versions stored usage in:

```text
~/.claude-code-router/data/usage.jsonl
```

On the first SQLite initialization, CCR imports valid records from `usage.jsonl` with `INSERT OR IGNORE`, skips malformed lines, and records migration metadata in SQLite. The JSONL file is retained as a backup and is not deleted or truncated. After the one-time migration metadata is written, CCR will not reimport the JSONL file, including after `DELETE /api/usage` clears SQLite rows.

## GET /api/usage

Get usage records with a summary for the full filtered result set. Pagination applies only to the returned `records` array; `summary` and `total` are calculated from every record that matches the filters.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startDate` | string | No | Include records with `timestamp >= startDate` (ISO 8601 recommended) |
| `endDate` | string | No | Include records with `timestamp <= endDate` (ISO 8601 recommended) |
| `model` | string | No | Filter by routed model |
| `provider` | string | No | Filter by provider name |
| `scenario` | string | No | Filter by scenario type |
| `clientType` | string | No | Filter by client type, such as `claude-code`, `codex`, `api`, or `unknown` |
| `sessionId` | string | No | Filter by session ID |
| `status` | string | No | Filter by `success` or `error` |
| `page` | integer | No | Page number, defaults to `1` |
| `pageSize` | integer | No | Records per page, defaults to `50` |

### Request Example

```bash
curl "http://localhost:3456/api/usage?provider=openai&page=1&pageSize=20" \
  -H "x-api-key: your-api-key"
```

### Response Example

```json
{
  "records": [
    {
      "id": "1735223422000-abc123",
      "timestamp": "2024-12-26T14:30:22.000Z",
      "sessionId": "session-id",
      "provider": "openai",
      "originalModel": "claude-3-5-sonnet-20241022",
      "model": "gpt-4o",
      "modelFamily": "gpt",
      "scenarioType": "default",
      "clientType": "claude-code",
      "stream": true,
      "inputTokens": 1200,
      "outputTokens": 350,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "ttft": 420,
      "tokensPerSecond": 58,
      "durationMs": 6420,
      "status": "success"
    }
  ],
  "summary": {
    "totalRequests": 1,
    "successCount": 1,
    "errorCount": 0,
    "totalInputTokens": 1200,
    "totalOutputTokens": 350,
    "totalCacheReadInputTokens": 0,
    "totalCacheCreationInputTokens": 0,
    "avgTtft": 420,
    "avgTokensPerSecond": 58,
    "byModel": {
      "gpt-4o": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    },
    "byProvider": {
      "openai": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    },
    "byScenario": {
      "default": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    },
    "byFamily": {
      "gpt/default": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    },
    "byDay": {
      "2024-12-26": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    },
    "byClient": {
      "claude-code": {
        "count": 1,
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0
      }
    }
  },
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## GET /api/usage/summary

Get a summary without returning individual records.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startDate` | string | No | Include records with `timestamp >= startDate` |
| `endDate` | string | No | Include records with `timestamp <= endDate` |
| `status` | string | No | Filter by `success` or `error` |

### Request Example

```bash
curl "http://localhost:3456/api/usage/summary?status=success" \
  -H "x-api-key: your-api-key"
```

## DELETE /api/usage

Clear usage data from SQLite.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `beforeDate` | string | No | If provided, delete rows with `timestamp < beforeDate`; otherwise delete all SQLite usage rows |

### Request Example (Clear All SQLite Usage)

```bash
curl -X DELETE "http://localhost:3456/api/usage" \
  -H "x-api-key: your-api-key"
```

### Request Example (Clear Older Rows)

```bash
curl -X DELETE "http://localhost:3456/api/usage?beforeDate=2024-12-01T00:00:00.000Z" \
  -H "x-api-key: your-api-key"
```

### Response Example

```json
{
  "success": true,
  "message": "All usage data cleared"
}
```

`DELETE /api/usage` only deletes rows from `usage.sqlite`. It does not delete the legacy `usage.jsonl` backup and does not reset the one-time migration metadata.
