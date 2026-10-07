#!/usr/bin/env python3
"""Check MXE stack diagnostics against the freshly linked, unstripped ELF.

Arcium 0.15 pulls unused anchor-syn code into SBF dependency compilation. LLVM
reports its frames before LTO removes it. Only an exact mangled symbol absent
from the final symbol table can be exempted; loan builds use check-sbf.sh.
"""
import glob
import os
from pathlib import Path
import re
import subprocess
import sys


def offending_symbol(line):
    if not re.search(r"Stack offset .*exceeded max offset|stack frame size .*exceeds|"
                     r"stack size .*exceeded|function call .*overwrites values in the frame", line, re.I):
        return None
    match = re.search(r"(?:Function|function call in method) (\S+) (?:Stack offset|overwrites values)", line)
    if not match:
        raise ValueError(f"Unrecognized stack diagnostic: {line}")
    return match[1]


def symbols_from_table(output):
    if "SYMBOL TABLE:" not in output:
        raise ValueError("Linked ELF has no readable symbol table")
    symbols = {line.split()[-1] for line in output.splitlines()
               if re.match(r"^[0-9a-fA-F]+\s", line)}
    if "entrypoint" not in symbols or len(symbols) < 2:
        raise ValueError("Linked ELF is stripped or lacks the program entrypoint")
    return symbols


def assert_removed(offenders, symbols):
    live = offenders & symbols
    if live:
        raise ValueError(f"Stack violations survive the final MXE link: {sorted(live)}")


def main():
    if len(sys.argv) < 2:
        raise ValueError("Pass the MXE build command")
    pattern = "target/*-solana-solana/release/zenlo_credit_mxe.so"
    # Cargo must produce a new final link, even when dependency compilation is cached.
    for artifact in glob.glob(pattern):
        Path(artifact).unlink()
    result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(result.stdout, end="")
    if result.returncode:
        return result.returncode
    artifacts = glob.glob(pattern)
    if len(artifacts) != 1:
        raise ValueError(f"Expected one freshly linked MXE ELF, found {artifacts}")
    artifact = Path(artifacts[0])
    with artifact.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            raise ValueError("MXE output is not an ELF")
    candidates = glob.glob(os.path.expanduser("~/.cache/solana/*/platform-tools/llvm/bin/llvm-objdump"))
    if not candidates:
        raise ValueError("Solana platform-tools llvm-objdump is unavailable")
    objdump = max(candidates, key=os.path.getmtime)
    table = subprocess.run([objdump, "--syms", str(artifact)], check=True, capture_output=True, text=True)
    symbols = symbols_from_table(table.stdout)
    offenders = {symbol for line in result.stdout.splitlines() if (symbol := offending_symbol(line))}
    assert_removed(offenders, symbols)
    for symbol in sorted(offenders):
        print(f"LTO removed stack diagnostic symbol: {symbol}")
    print(f"Checked {len(symbols)} symbols in fresh unstripped {artifact}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"MXE artifact check failed: {error}", file=sys.stderr)
        sys.exit(1)
