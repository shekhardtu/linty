// Keeps a named app responsible for the synthetic child test's Accessibility access.
// No real application is targeted; no keyboard, clipboard, or TCC mutation is used.
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <limits.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;

static int result(const char *path, int code, int trusted, int completed) {
    FILE *file = fopen(path, "w");
    if (!file) { perror("Could not write native test result"); return 1; }
    fprintf(file, "{\"exitCode\":%d,\"trusted\":%s,\"testCompleted\":%s}\n", code, trusted ? "true" : "false", completed ? "true" : "false");
    fclose(file);
    return code;
}
int main(int argc, char **argv) {
    // Finder/double-click launch intentionally cannot request permissions or run tests.
    if (argc != 3 || strcmp(argv[1], "--run") != 0 || argv[2][0] != '/') {
        fputs("Prepare with test-editor-native.mjs, then explicitly use --run.\n", stderr);
        return 2;
    }
    setvbuf(stdout, NULL, _IONBF, 0);
    CFBundleRef bundle = CFBundleGetMainBundle();
    CFURLRef resources = bundle ? CFBundleCopyResourcesDirectoryURL(bundle) : NULL;
    UInt8 directory[PATH_MAX];
    if (!resources || !CFURLGetFileSystemRepresentation(resources, true, directory, sizeof(directory))) {
        if (resources) CFRelease(resources);
        fputs("Could not locate bundled synthetic test resources.\n", stderr);
        return result(argv[2], 2, 0, 0);
    }
    CFRelease(resources);
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    if (!trusted) puts("Linty Editor Test needs Accessibility access only to its own synthetic background text fixture. Waiting up to two minutes for approval; no settings are changed automatically.");
    for (int attempts = 0; !trusted && attempts < 240; attempts++) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);
        usleep(500000);
        trusted = AXIsProcessTrusted();
    }
    if (!trusted) { fputs("Accessibility was not granted; the synthetic test was not run.\n", stderr); return result(argv[2], 3, 0, 0); }
    char executable[PATH_MAX], fixture[PATH_MAX];
    if (snprintf(executable, sizeof(executable), "%s/linty-editor-tests", directory) >= (int)sizeof(executable) ||
        snprintf(fixture, sizeof(fixture), "%s/editor-accessibility-fixture", directory) >= (int)sizeof(fixture)) {
        return result(argv[2], 2, 1, 0);
    }
    if (setenv("LINTY_CORRECTION_FIXTURE", fixture, 1) != 0) { perror("Could not configure fixture"); return result(argv[2], 2, 1, 0); }
    char *args[] = { executable, "corrections::accessibility::tests::native_selected_edit_rejects_stale_targets_and_preserves_surroundings", "--ignored", "--exact", "--nocapture", NULL };
    pid_t child;
    int error = posix_spawn(&child, executable, NULL, NULL, args, environ);
    if (error) { errno = error; perror("Could not launch synthetic native test"); return result(argv[2], 2, 1, 0); }
    int status;
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) { perror("Could not wait for native test"); return result(argv[2], 2, 1, 0); } }
    int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    return result(argv[2], code, 1, 1);
}
