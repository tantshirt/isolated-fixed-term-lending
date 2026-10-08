import importlib.util
from pathlib import Path
import subprocess
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mxe_guard", HERE / "check-mxe-sbf.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class BuildGuards(unittest.TestCase):
    def test_strict_guard_preserves_success_and_failure(self):
        for command, expected in [("exit 0", 0), ("exit 23", 23),
                                  ("echo 'Error: Function _ZNfoo Stack offset of 5056 exceeded max offset of 4096'", 1),
                                  ("echo 'Error: A function call in method _ZNfoo overwrites values in the frame.'", 1)]:
            with self.subTest(command=command):
                result = subprocess.run(["bash", str(HERE / "check-sbf.sh"), "bash", "-c", command], capture_output=True)
                self.assertEqual(result.returncode, expected)

    def test_diagnostic_extracts_exact_mangled_symbol(self):
        self.assertEqual(guard.offending_symbol("Error: Function _ZNfoo17abcE Stack offset of 5056 exceeded max offset of 4096"), "_ZNfoo17abcE")
        self.assertEqual(guard.offending_symbol("Error: A function call in method _ZNfoo17abcE overwrites values in the frame."), "_ZNfoo17abcE")
        self.assertIsNone(guard.offending_symbol("Finished release profile"))
        with self.assertRaises(ValueError):
            guard.offending_symbol("Error: unknown stack frame size 5000 exceeds 4096")

    def test_stripped_and_unreadable_tables_fail_closed(self):
        for output in ["", "SYMBOL TABLE:\n", "SYMBOL TABLE:\n00000000 g F .text 00000001 entrypoint\n"]:
            with self.subTest(output=output), self.assertRaises(ValueError):
                guard.symbols_from_table(output)

    def test_table_keeps_exact_symbol_identity(self):
        symbols = guard.symbols_from_table("SYMBOL TABLE:\n00000000 g F .text 00000001 entrypoint\n00000008 l F .text 00000001 .hidden _ZNfoo17abcE\n")
        self.assertIn("_ZNfoo17abcE", symbols)
        self.assertNotIn("_ZNfoo17abc", symbols)
        with self.assertRaises(ValueError):
            guard.assert_removed({"_ZNfoo17abcE"}, symbols)
        guard.assert_removed({"_ZNunused17defE"}, symbols)


if __name__ == "__main__":
    unittest.main()
