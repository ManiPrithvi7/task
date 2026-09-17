#!/usr/bin/env python3
"""Re-sign the existing Root CA certificate (same key). Does not rotate the CA key.

Keeps: private key, subject, issuer, serial, SKI, validity, basicConstraints, keyUsage.
Adds: AKI keyid-only equal to SKI (never empty SEQUENCE 3000, never issuer+serial).
Signs TBS with the existing CA key so self-signature and leaf verify stay valid.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.oid import ExtensionOID

KEEP_EXTENSIONS = (
    ExtensionOID.BASIC_CONSTRAINTS,
    ExtensionOID.KEY_USAGE,
    ExtensionOID.SUBJECT_KEY_IDENTIFIER,
)


def load_cert(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def load_key(path: Path):
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def resign(old: x509.Certificate, key) -> x509.Certificate:
    pub_from_key = key.public_key()
    pub_from_cert = old.public_key()
    if pub_from_key.public_numbers() != pub_from_cert.public_numbers():
        raise SystemExit("CA key does not match CA certificate public key — aborting")

    builder = (
        x509.CertificateBuilder()
        .subject_name(old.subject)
        .issuer_name(old.issuer)
        .public_key(old.public_key())
        .serial_number(old.serial_number)
        .not_valid_before(old.not_valid_before_utc)
        .not_valid_after(old.not_valid_after_utc)
    )
    ski_ext = old.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_KEY_IDENTIFIER)
    for oid in KEEP_EXTENSIONS:
        ext = old.extensions.get_extension_for_oid(oid)
        builder = builder.add_extension(ext.value, critical=ext.critical)
    builder = builder.add_extension(
        x509.AuthorityKeyIdentifier(
            key_identifier=ski_ext.value.digest,
            authority_cert_issuer=None,
            authority_cert_serial_number=None,
        ),
        critical=False,
    )

    return builder.sign(private_key=key, algorithm=hashes.SHA256())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-cert", required=True, type=Path)
    parser.add_argument("--ca-key", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    old = load_cert(args.old_cert)
    key = load_key(args.ca_key)
    new = resign(old, key)
    pem = new.public_bytes(serialization.Encoding.PEM)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(pem)
    if hasattr(args.out, "chmod"):
        args.out.chmod(0o644)
    print(f"wrote {args.out} ({len(pem)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
