public class Sample {
    static class Box {
        String label;
        int value;
        Box peer;

        Box(String label, int value) {
            this.label = label;
            this.value = value;
        }

        int add(int amount) {
            value = value + amount;
            return value;
        }
    }

    public static void main(String[] args) {
        Box box = new Box("Code Memory", 1);
        Box alias = box;
        Box other = new Box("Other", 2);
        box.peer = other;
        int total = alias.add(2);
        System.out.println(box.label + " " + total);
    }
}