package com.clawterm.app;

/**
 * A failure that carries a machine-readable code.
 *
 * The code is what crosses the bridge; the message is for logs and for the
 * fallback case where the UI has no translation for it. Keeping the two apart is
 * what lets the UI say "wrong password" in the user's language instead of
 * printing JSch's English.
 */
final class SshException extends Exception {

    final String code;

    SshException(String message, String code) {
        super(message);
        this.code = code;
    }
}
