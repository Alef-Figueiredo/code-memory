class Counter:
    def __init__(self, label):
        self.label = label
        self.values = []

    def add(self, value):
        self.values.append(value)
        return sum(self.values)


counter = Counter("Code Memory")
alias = counter
first = counter.add(1)
second = alias.add(2)
print(counter.label, second)