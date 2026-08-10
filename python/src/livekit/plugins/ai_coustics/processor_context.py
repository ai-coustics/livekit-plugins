from __future__ import annotations

from collections.abc import Callable

import aic_sdk

from .log import logger


class ProcessorContext:
    """Logging wrapper around :class:`aic_sdk.ProcessorContext`."""

    def __init__(
        self,
        context: aic_sdk.ProcessorContext,
        diagnostic_fields: Callable[..., dict[str, object]],
    ) -> None:
        self._context = context
        self._diagnostic_fields = diagnostic_fields

    def reset(self) -> None:
        self._context.reset()
        logger.debug(
            "ai-coustics Processor reset",
            extra=self._diagnostic_fields(),
        )

    def set_parameter(
        self,
        parameter: aic_sdk.ProcessorParameter,
        value: float,
    ) -> None:
        """Set an SDK parameter, logging a warning if the SDK rejects the value."""

        try:
            self._context.set_parameter(parameter, value)
        except Exception as error:
            logger.warning(
                "ai-coustics Processor parameter rejected; keeping the current value",
                extra=self._diagnostic_fields(
                    context_operation="set_parameter",
                    parameter=str(parameter),
                    parameter_value=value,
                    error_type=type(error).__name__,
                    error_message=str(error),
                ),
            )
            return
        logger.debug(
            "ai-coustics Processor parameter updated",
            extra=self._diagnostic_fields(
                parameter=str(parameter),
                parameter_value=value,
            ),
        )

    def get_parameter(self, parameter: aic_sdk.ProcessorParameter) -> float:
        return self._context.get_parameter(parameter)

    def get_audio_delay(self) -> int:
        return self._context.get_audio_delay()

    def update_bearer_token(self, token: str) -> None:
        try:
            self._context.update_bearer_token(token)
        except Exception as error:
            logger.warning(
                "ai-coustics Processor bearer token update failed; keeping the current token",
                extra=self._diagnostic_fields(
                    context_operation="update_bearer_token",
                    error_type=type(error).__name__,
                    error_message=str(error),
                ),
                exc_info=(type(error), error, error.__traceback__),
            )
            raise
        logger.debug(
            "ai-coustics Processor bearer token updated",
            extra=self._diagnostic_fields(),
        )
