package {{module}};

public class App {
    public String greeting() {
        return "Hello from {{title}}!";
    }

    public static void main(String[] args) {
        System.out.println(new App().greeting());
    }
}
