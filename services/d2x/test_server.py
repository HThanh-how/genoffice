"""Gateway smoke tests that do not require LibreOffice to be installed."""

import http.client
import sys
import threading
import unittest

import server


class GatewayTest(unittest.TestCase):
    def setUp(self) -> None:
        server.CONVERTER = sys.executable
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def request(
        self, method: str, path: str, body: bytes = b"", declared_length: int | None = None,
        content_type: str = "application/msword",
    ) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        headers = {"Content-Type": content_type}
        if declared_length is not None:
            headers["Content-Length"] = str(declared_length)
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_health_and_invalid_document(self) -> None:
        self.assertEqual(self.request("GET", "/health"), (200, b"ok"))
        status, message = self.request("POST", "/v1/convert/docx", b"not-a-word-file")
        self.assertEqual(status, 422)
        self.assertIn(b"Invalid legacy", message)

    def test_size_limit(self) -> None:
        status, _ = self.request("POST", "/v1/convert/docx", b"x", server.MAX_INPUT + 1)
        self.assertEqual(status, 413)

    def test_legacy_presentation_endpoint(self) -> None:
        status, message = self.request(
            "POST", "/v1/convert/pptx", b"not-a-presentation",
            content_type="application/vnd.ms-powerpoint",
        )
        self.assertEqual(status, 422)
        self.assertIn(b".ppt", message)
        status, _ = self.request("POST", "/v1/convert/pptx", b"bad-mime")
        self.assertEqual(status, 415)


if __name__ == "__main__":
    unittest.main()
