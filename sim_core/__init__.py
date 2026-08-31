"""sim-core：家族模拟器纯核心。DESIGN.md 见仓库根目录。"""

from .params import Params, EraParams, default_params, scale_for
from .person import Person
from .rng import Streams
from .village import Village
from .engine import run, seed_village, SimResult

__all__ = [
    "Params", "EraParams", "default_params", "scale_for",
    "Person", "Streams", "Village", "run", "seed_village", "SimResult",
]
