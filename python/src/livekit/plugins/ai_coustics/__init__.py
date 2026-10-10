import warnings
from importlib.metadata import PackageNotFoundError, version

from aic_sdk import Model, ProcessorParameter
from livekit.agents import Plugin

from .analyzer import AnalysisEvent, Analyzer, Collector
from .frame_processor_chain import FrameProcessorChain
from .log import logger
from .processor import Processor
from .processor_context import ProcessorContext
from .vad import VAD, VADParameters, VADProcessor

try:
    __version__ = version("ai-coustics-livekit-plugin")
except PackageNotFoundError:  # pragma: no cover - source tree without installation
    __version__ = "0.0.0"


class AICousticsPlugin(Plugin):
    def __init__(self) -> None:
        super().__init__(__name__, __version__, __package__ or __name__, logger)


Plugin.register_plugin(AICousticsPlugin())

# Python hides a DeprecationWarning from an import by default. A FutureWarning is visible.
warnings.warn(
    "ai-coustics-livekit-plugin is deprecated. Use ai-coustics-livekit-extras for VAD and "
    "Analyzer, and livekit-plugins-ai-coustics for speech enhancement. Migration guide: "
    "https://docs.ai-coustics.com/reference/livekit/migrate-to-livekit-extras",
    FutureWarning,
    stacklevel=2,
)

__all__ = [
    "AICousticsPlugin",
    "AnalysisEvent",
    "Analyzer",
    "Collector",
    "FrameProcessorChain",
    "Model",
    "Processor",
    "ProcessorContext",
    "ProcessorParameter",
    "VAD",
    "VADParameters",
    "VADProcessor",
    "__version__",
]
