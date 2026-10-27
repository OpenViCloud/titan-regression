#!/usr/bin/env python3
"""Tests of trim-cp-log.py. Run: python3 test_trim_cp_log.py"""
import pathlib
import subprocess
import sys
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "trim-cp-log.py"

LOG = """info: Microsoft.AspNetCore.Hosting.Diagnostics[1]
      Request starting HTTP/1.1 GET http://api/v1/clusters - - -
info: Microsoft.EntityFrameworkCore.Database.Command[20101]
      Executed DbCommand (2ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
      SELECT 1
info: Microsoft.AspNetCore.Routing.EndpointMiddleware[0]
      Executing endpoint 'HTTP: GET /v1/clusters'
info: Titan.Application.Services.Billing.Metering.ComputeMeterService[0]
      meter tick wrote 3 records
warn: Microsoft.EntityFrameworkCore.Database.Command[20102]
      Failed executing DbCommand (5ms)
fail: Microsoft.AspNetCore.Hosting.Diagnostics[0]
      Unhandled exception
=== control-plane-abc since 2026-10-17T00:00:00Z
info: Microsoft.AspNetCore.Hosting.Diagnostics[2]
      Request finished HTTP/1.1 GET http://api/v1/clusters - 200
"""


def trim(text):
    return subprocess.run([sys.executable, str(SCRIPT)], input=text, capture_output=True, text=True, check=True).stdout


class TrimCpLogTests(unittest.TestCase):
    def test_drops_the_info_records_of_the_three_framework_categories_with_their_body(self):
        out = trim(LOG)
        self.assertNotIn("Request starting", out)
        self.assertNotIn("SELECT 1", out)
        self.assertNotIn("Executing endpoint", out)
        self.assertNotIn("Request finished", out)

    def test_keeps_titan_lines_warn_fail_and_the_pod_separator(self):
        out = trim(LOG)
        self.assertIn("meter tick wrote 3 records", out)
        self.assertIn("warn: Microsoft.EntityFrameworkCore.Database.Command[20102]\n      Failed executing DbCommand", out)
        self.assertIn("fail: Microsoft.AspNetCore.Hosting.Diagnostics[0]\n      Unhandled exception", out)
        self.assertIn("=== control-plane-abc since", out)


if __name__ == "__main__":
    unittest.main()
