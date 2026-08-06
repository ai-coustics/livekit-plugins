from importlib.metadata import PackageNotFoundError, version

from aic_sdk import Model, OtelConfig, ProcessorContext, ProcessorParameter
from livekit.agents import Plugin

from .log import logger
from .processor import Processor, ProcessorParameters

try:
    __version__ = version("ai-coustics-livekit")
except PackageNotFoundError:  # pragma: no cover - source tree without installation
    __version__ = "0.0.0"


class AICousticsPlugin(Plugin):
    def __init__(self) -> None:
        super().__init__(__name__, __version__, __package__ or __name__, logger)


Plugin.register_plugin(AICousticsPlugin())

__all__ = [
    "AICousticsPlugin",
    "Model",
    "OtelConfig",
    "ProcessorContext",
    "Processor",
    "ProcessorParameters",
    "ProcessorParameter",
    "__version__",
]
