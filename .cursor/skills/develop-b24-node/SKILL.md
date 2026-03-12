---
name: develop-b24-node
description: Develop backend applications for Bitrix24 using Node.js, Express, and Bitrix24 JS SDK. Use this skill when you need to create API endpoints, work with Bitrix24 data, or manage authentication in Node.js.
---

# Develop Bitrix24 Node.js Backend

## Quick Start

The Node.js backend is built with **Express** and uses **@bitrix24/b24jssdk** for Bitrix24 interaction.

### Key Files

*   `backends/node/api/server.js`: Main entry point and API routes.
*   `backends/node/api/utils/verifyToken.js`: JWT verification middleware.

## Creating API Endpoints

Use Express routing and the `verifyToken` middleware.

```javascript
import verifyToken from './utils/verifyToken.js';

app.get('/api/my-endpoint', verifyToken, async (req, res) => {
  // JWT payload is available in req.user (if verifyToken adds it, check implementation)
  // or you can decode it manually if needed
  
  res.json({ data: 'value' });
});
```

## Bitrix24 Interaction (JS SDK)

Use `@bitrix24/b24jssdk` (specifically `B24Hook` for backend or `B24Frame` if rendering UI, but usually backend uses Hook or OAuth).

### Initialization

```javascript
import { B24Hook } from '@bitrix24/b24jssdk';

// Initialize with webhook URL (from env or DB)
const b24 = new B24Hook({
  b24Url: 'https://your-portal.bitrix24.com',
  userId: 1,
  secret: 'webhook_token'
});
```

### Common Operations

```javascript
const result = await b24.callMethod('crm.deal.list', {
  select: ['ID', 'TITLE']
});
const deals = result.getData();
```

## Authentication Flow

1.  **Installation**: `/api/install` receives OAuth data.
2.  **Token Issue**: `/api/getToken` issues a JWT for the frontend using `jsonwebtoken`.
3.  **Requests**: Frontend sends JWT in `Authorization` header. `verifyToken` middleware validates it.

## Database

*   **Drivers**: `pg` (PostgreSQL) or `mysql2` (MySQL).
*   **Configuration**: Based on `DB_TYPE` env var.
*   **Connection**: `pool` object in `server.js`.

## Best Practices

1.  **Middleware**: Use `verifyToken` for protected routes.
2.  **Async/Await**: Use async/await for database and API calls.
3.  **Environment**: Use `process.env` for configuration.
