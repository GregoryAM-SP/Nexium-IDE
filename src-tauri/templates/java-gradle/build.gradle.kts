plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass = "{{module}}.App"
}

// Compiles for Java 21 with whichever JDK runs Gradle (21 or newer).
tasks.withType<JavaCompile> {
    options.release = 21
}

tasks.test {
    useJUnitPlatform()
}
