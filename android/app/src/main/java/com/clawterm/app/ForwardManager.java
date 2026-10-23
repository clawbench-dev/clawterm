package com.clawterm.app;

import com.jcraft.jsch.ChannelDirectTCPIP;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Local port forwards: `127.0.0.1:<local>` → `<remote>:<port>` over SSH.
 *
 * ## Why the listener binds loopback
 *
 * A forward that listens on `0.0.0.0` exposes the remote service (a database, an
 * internal admin panel) to the entire local network. That is never what "forward
 * port 5432" means, so the bind address is not configurable.
 *
 * ## Why a channel per accepted connection
 *
 * `direct-tcpip` channels are independent: closing one (a dropped HTTP request)
 * must not disturb the others. Sharing a single channel would also break
 * protocols that open several concurrent connections.
 */
final class ForwardManager {

    interface Listener {
        void onStatus(int localPort, boolean running, long connections, String error);
    }

    private static final class Forward {
        final int localPort;
        final long hostId;
        final String remoteHost;
        final int remotePort;
        final SshConnection conn;
        final ServerSocket server;
        final List<Socket> sockets = new ArrayList<>();
        long connections;
        String error;
        volatile boolean running = true;

        Forward(int localPort, long hostId, String remoteHost, int remotePort,
                SshConnection conn, ServerSocket server) {
            this.localPort = localPort;
            this.hostId = hostId;
            this.remoteHost = remoteHost;
            this.remotePort = remotePort;
            this.conn = conn;
            this.server = server;
        }
    }

    private final Map<Integer, Forward> running = new HashMap<>();
    private final Listener listener;

    ForwardManager(Listener listener) {
        this.listener = listener;
    }

    /**
     * Bind and start accepting.
     *
     * @throws SshException when the port is taken or cannot be bound; the caller
     *         shows the OS reason, which is the actionable part ("address already
     *         in use").
     */
    synchronized void start(long hostId, SshConnection conn, int localPort,
                            String remoteHost, int remotePort) throws SshException {
        if (running.containsKey(localPort)) {
            throw new SshException("local port " + localPort + " is already forwarded", "port_in_use");
        }
        ServerSocket server;
        try {
            // Loopback only. See the class comment.
            server = new ServerSocket(localPort, 16, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) {
            throw new SshException(String.valueOf(e.getMessage()), "port_in_use");
        }

        Forward f = new Forward(localPort, hostId, remoteHost, remotePort, conn, server);
        running.put(localPort, f);
        conn.retain();

        Thread t = new Thread(() -> acceptLoop(f), "fwd-" + localPort);
        t.setDaemon(true);
        t.start();

        listener.onStatus(localPort, true, 0, null);
    }

    private void acceptLoop(Forward f) {
        while (f.running) {
            Socket client;
            try {
                client = f.server.accept();
            } catch (IOException e) {
                // The listener was closed by stop(); that is the normal exit.
                break;
            }
            synchronized (f) {
                f.connections++;
                f.sockets.add(client);
            }
            listener.onStatus(f.localPort, true, f.connections, f.error);

            Thread h = new Thread(() -> handle(f, client), "fwd-" + f.localPort + "-conn");
            h.setDaemon(true);
            h.start();
        }
    }

    private void handle(Forward f, Socket client) {
        ChannelDirectTCPIP channel = null;
        try {
            Session session = f.conn.session();
            channel = (ChannelDirectTCPIP) session.openChannel("direct-tcpip");
            channel.setHost(f.remoteHost);
            channel.setPort(f.remotePort);
            channel.setOrgIPAddress(client.getInetAddress().getHostAddress());
            channel.setOrgPort(client.getPort());

            InputStream fromRemote = channel.getInputStream();
            OutputStream toRemote = channel.getOutputStream();
            channel.connect(15_000);

            InputStream fromClient = client.getInputStream();
            OutputStream toClient = client.getOutputStream();

            // Two pumps; the first to finish closes both, so a half-closed socket
            // cannot leave the other pump blocked forever.
            Thread up = pump(fromClient, toRemote);
            Thread down = pump(fromRemote, toClient);
            up.join();
            down.join();
        } catch (Exception e) {
            synchronized (f) {
                f.error = String.valueOf(e.getMessage());
            }
            listener.onStatus(f.localPort, true, f.connections, f.error);
        } finally {
            SshConnection.closeQuietly(channel);
            try {
                client.close();
            } catch (IOException ignored) {
                // Already closed.
            }
            synchronized (f) {
                f.sockets.remove(client);
            }
        }
    }

    private Thread pump(final InputStream in, final OutputStream out) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    out.flush();
                }
            } catch (IOException ignored) {
                // Either side closing ends the pump; the other one follows.
            }
        });
        t.setDaemon(true);
        t.start();
        return t;
    }

    /** Stop one forward. Idempotent. */
    synchronized void stop(int localPort) {
        Forward f = running.remove(localPort);
        if (f == null) return;
        f.running = false;
        try {
            f.server.close();
        } catch (IOException ignored) {
            // Already closed.
        }
        synchronized (f) {
            for (Socket s : new ArrayList<>(f.sockets)) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // Already closed.
                }
            }
            f.sockets.clear();
        }
        if (f.conn.release()) f.conn.close();
        listener.onStatus(localPort, false, f.connections, null);
    }

    /** Stop every forward belonging to a host (its connection went away). */
    synchronized void stopHost(long hostId) {
        List<Integer> ports = new ArrayList<>();
        for (Forward f : running.values()) {
            if (f.hostId == hostId) ports.add(f.localPort);
        }
        for (int p : ports) stop(p);
    }

    synchronized void stopAll() {
        for (int p : new ArrayList<>(running.keySet())) stop(p);
    }

    synchronized boolean isRunning(int localPort) {
        return running.containsKey(localPort);
    }

    synchronized long connections(int localPort) {
        Forward f = running.get(localPort);
        return f == null ? 0 : f.connections;
    }

    synchronized String error(int localPort) {
        Forward f = running.get(localPort);
        return f == null ? null : f.error;
    }
}
