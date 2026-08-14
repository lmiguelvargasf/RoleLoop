import pytest

from roleloop.domain import InvalidJobUrl, canonicalize_job_url


def test_canonicalizes_tracking_host_port_path_and_query() -> None:
    assert (
        canonicalize_job_url(
            " HTTPS://ExAmPle.COM:443/a/../jobs/42/?utm_source=mail&b=2&a=1#apply "
        )
        == "https://example.com/jobs/42?a=1&b=2"
    )


def test_preserves_meaningful_blank_and_repeated_query_values() -> None:
    assert (
        canonicalize_job_url("http://example.com:80/jobs?id=2&id=1&empty=&gclid=ignored")
        == "http://example.com/jobs?empty=&id=1&id=2"
    )


def test_encoded_slash_does_not_collapse_into_a_path_separator() -> None:
    encoded = canonicalize_job_url("https://example.com/jobs/a%2fb")
    separated = canonicalize_job_url("https://example.com/jobs/a/b")

    assert encoded == "https://example.com/jobs/a%2Fb"
    assert encoded != separated


@pytest.mark.parametrize(
    "url",
    [
        "",
        "ftp://example.com/job",
        "https:///job",
        "https://user:secret@example.com/job",
        "https://example.com:bad/job",
    ],
)
def test_rejects_urls_that_cannot_identify_a_safe_web_resource(url: str) -> None:
    with pytest.raises(InvalidJobUrl):
        canonicalize_job_url(url)
