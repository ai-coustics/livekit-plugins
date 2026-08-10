import logging
from collections.abc import Callable, Coroutine
from functools import wraps
from typing import Any, ParamSpec, TypeVar, cast

logger = logging.getLogger("livekit.plugins.ai_coustics")

PLUGIN_NAME = "ai-coustics"
P = ParamSpec("P")
T = TypeVar("T")


def log_fields(component: str, **fields: object) -> dict[str, object]:
    """Return the common structured fields for an ai-coustics log record."""

    return {"plugin": PLUGIN_NAME, "component": component, **fields}


def log_async_exceptions(
    component: str, message: str
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """Log uncaught coroutine failures with the plugin's standard fields and message shape."""

    def decorator(
        function: Callable[P, Coroutine[Any, Any, T]],
    ) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(function)
        async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
            try:
                return await function(*args, **kwargs)
            except Exception:
                logger.exception(message, extra=log_fields(component))
                raise

        return cast(Callable[P, Coroutine[Any, Any, T]], wrapped)

    return decorator
