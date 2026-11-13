import importlib.util
from pathlib import Path
import sys
import unittest


if len(sys.argv) != 2:
    raise SystemExit('Usage: runPythonTests.py path/to/test.py')
path = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(path.parent))
spec = importlib.util.spec_from_file_location('renderer_tests', path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
suite = unittest.defaultTestLoader.loadTestsFromModule(module)
if suite.countTestCases() == 0:
    raise SystemExit(f'No Python tests were found in {path.name}.')
result = unittest.TextTestRunner(verbosity=2).run(suite)
if result.skipped:
    for test, reason in result.skipped:
        print(f'Renderer validation does not permit skipped tests: {test}: {reason}', file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)
