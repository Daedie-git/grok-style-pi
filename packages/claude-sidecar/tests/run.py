#!/usr/bin/env python3
"""Run the Python tests in parallel, one test per worker: python3 tests/run.py [-j N] [name-filter]"""
import argparse
import io
import os
import sys
import time
import unittest
from concurrent.futures import ProcessPoolExecutor

TESTS = os.path.dirname(os.path.abspath(__file__))


def ids(suite):
    for test in suite:
        yield from ids(test) if isinstance(test, unittest.TestSuite) else [test.id()]


def run_one(test_id):
    sys.path.insert(0, TESTS)
    stream = io.StringIO()
    start = time.monotonic()
    result = unittest.TextTestRunner(stream=stream, verbosity=0).run(
        unittest.defaultTestLoader.loadTestsFromName(test_id))
    return test_id, result.wasSuccessful(), time.monotonic() - start, stream.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-j', type=int, default=min(32, os.cpu_count() or 4))
    parser.add_argument('filter', nargs='?', default='')
    args = parser.parse_args()
    sys.path.insert(0, TESTS)
    tests = [t for t in ids(unittest.defaultTestLoader.discover(TESTS)) if args.filter in t]
    start, failed = time.monotonic(), []
    with ProcessPoolExecutor(args.j) as pool:
        for test_id, ok, _, output in pool.map(run_one, tests):
            if not ok:
                failed.append(test_id)
                print(output, file=sys.stderr)
    print(f'{len(tests) - len(failed)}/{len(tests)} passed in {time.monotonic() - start:.1f}s')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
