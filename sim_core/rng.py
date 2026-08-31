"""RNG 分流：era/match/birth/death/migrate 各自独立子流。

主 seed 经 SHA-256 派生子流 seed，任何一处参数微调不破坏其他子流复现。
"""

from __future__ import annotations

import hashlib

import numpy as np

STREAMS = ("era", "match", "birth", "death", "migrate", "name", "flavor")


def derive_seed(master: int, stream: str) -> int:
    h = hashlib.sha256(f"{master}:{stream}".encode()).digest()
    return int.from_bytes(h[:8], "little")


class Streams:
    def __init__(self, master_seed: int):
        self._rngs = {s: np.random.default_rng(derive_seed(master_seed, s)) for s in STREAMS}

    def __getitem__(self, stream: str) -> np.random.Generator:
        return self._rngs[stream]
