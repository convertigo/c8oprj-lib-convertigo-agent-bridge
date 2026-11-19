import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;

/** Checks the native Java method shape seen by Rhino, without starting any proxy. */
public class ProxyApiDetectionProbe {
    private static int calls;

    public static void configureProxyEnvironment(Map<String, String> environment) {
        calls++;
        throw new AssertionError("Discovery must not invoke the proxy helper");
    }

    public static void main(String[] args) throws Exception {
        try (Context cx = Context.enter()) {
            cx.setLanguageVersion(Context.VERSION_ES6);
            Scriptable scope = cx.initStandardObjects();
            cx.evaluateString(scope, Files.readString(Path.of(args[0])), "proxy-api-detection", 1, null);
            cx.evaluateString(scope, "var apiClass=\"ProxyApiDetectionProbe\"; var actualClass=java.lang.Class; " +
                    "var Packages={java:{lang:{Class:{forName:function(name){" +
                    "if(name!==\"com.twinsoft.convertigo.engine.util.ProcessUtils\")throw Error(\"Unexpected class\");" +
                    "return actualClass.forName(apiClass);}}}}};", "native-api", 1, null);
            Object modern = cx.evaluateString(scope, "engineProcessProxyAvailable();", "modern", 1, null);
            if (!Context.toBoolean(modern) || calls != 0) {
                throw new AssertionError("Native Java API must be discovered without invocation");
            }
            cx.evaluateString(scope, "apiClass=\"java.lang.System\";", "legacy-api", 1, null);
            if (Context.toBoolean(cx.evaluateString(scope, "engineProcessProxyAvailable();", "legacy", 1, null))) {
                throw new AssertionError("Missing API must keep the older-engine path");
            }
            System.out.println("PASS native API discovery and legacy fallback");
        }
    }
}
