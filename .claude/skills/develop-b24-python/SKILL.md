---
name: develop-b24-python
description: Develop backend applications for Bitrix24 using Python, Django, and b24pysdk. Use this skill when you need to create API endpoints, work with Bitrix24 data, or manage authentication in Python.
---

# Develop Bitrix24 Python Backend

## Quick Start

The Python backend is built with **Django** and uses **b24pysdk** for Bitrix24 interaction.

### Key Directories

*   `backends/python/api/main/views.py`: API endpoints.
*   `backends/python/api/main/models.py`: Database models (`Bitrix24Account`).
*   `backends/python/api/main/utils/`: Decorators and helpers.

## Creating API Endpoints

Use the `@auth_required` decorator to handle authentication (JWT or OAuth).

```python
from django.http import JsonResponse
from django.views.decorators.http import require_GET
from django.views.decorators.clickjacking import xframe_options_exempt
from .utils.decorators import auth_required, log_errors
from .utils import AuthorizedRequest

@xframe_options_exempt
@require_GET
@log_errors("my_endpoint")
@auth_required
def my_endpoint(request: AuthorizedRequest):
    # Access Bitrix24 account
    b24_account = request.bitrix24_account
    
    # Use the client to call Bitrix24 API
    client = b24_account.client
    deals = client.call("crm.deal.list", {"select": ["ID", "TITLE"]})
    
    return JsonResponse({"data": deals})
```

## Bitrix24 Interaction (b24pysdk)

The `request.bitrix24_account.client` provides a wrapper around `b24pysdk`.

### Common Operations

```python
# Call a single method
result = client.call("crm.deal.get", {"id": 123})

# Batch request (if supported by SDK wrapper, otherwise use call_batch)
# Check b24pysdk documentation for specific batch syntax
```

## Authentication Flow

1.  **Installation**: `/api/install` receives OAuth data, creates `Bitrix24Account`.
2.  **Token Issue**: `/api/getToken` issues a JWT for the frontend.
3.  **Requests**: Frontend sends JWT in `Authorization` header. `@auth_required` validates it and populates `request.bitrix24_account`.

## Database

*   **Models**: Defined in `main/models.py`.
*   **Migrations**: Run automatically in Docker, or manually via `python manage.py makemigrations` / `migrate`.
*   **Bitrix24Account**: Stores tokens and portal info.

## Best Practices

1.  **Decorators**: Always use `@xframe_options_exempt`, `@log_errors`, and `@auth_required` for API views.
2.  **Typing**: Use `AuthorizedRequest` for type hinting.
3.  **Error Handling**: `log_errors` catches exceptions, but handle specific logic errors within the view.
4.  **Async**: Django views are synchronous by default. For long operations, use Celery (see `instructions/queues/python.md`).
